import { test, expect } from '@playwright/test'
import { randomBytes, randomUUID } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import * as tls from 'node:tls'
import { ADMIN, PORTAL, closeSessions, headersOf, useBrowser } from './auth'
import { API, bodyOf, call, expectError, expectStatus, log, startLog } from './api'
import { startLocalProxyIfNeeded } from './local-proxy'

// Cases CON-03..09 and CON-12 of plan.md. CON-01 (PUT/PATCH answer 204 with no body) and CON-02 (async POST
// actions answer 202 with no body) are asserted where each route runs: NET-06, VM-08, TEN-02, TEN-04, BIL-08 and
// BIL-04, BIL-07, BIL-10, CAT-06.

// The twelve creates that carry IRequiresIdempotencyKey (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/{Vm,Volume,
// Network,VmSnapshots,VolumeSnapshots,TopUp,SshKey,ApiToken,LoadBalancer}/*). Route ids are random: the key check runs before the endpoint.
function twelveCreates(): Array<{ as: 'tenant' | 'admin', path: string }> {
  const id = randomUUID()
  return [
    { as: 'tenant', path: '/v1/tenant/vms' },
    { as: 'tenant', path: '/v1/tenant/networks' },
    { as: 'tenant', path: `/v1/tenant/networks/${id}/firewall-rules` },
    { as: 'tenant', path: '/v1/tenant/volumes' },
    { as: 'tenant', path: `/v1/tenant/vms/${id}/snapshots` },
    { as: 'tenant', path: `/v1/tenant/volumes/${id}/snapshots` },
    { as: 'tenant', path: `/v1/tenant/volumes/${id}/snapshots/${randomUUID()}/restore` },
    { as: 'tenant', path: '/v1/tenant/topups' },
    { as: 'tenant', path: '/v1/tenant/ssh-keys' },
    { as: 'tenant', path: '/v1/tenant/api-tokens' },
    { as: 'tenant', path: '/v1/tenant/load-balancers' },
    { as: 'admin', path: '/v1/admin/topups/grant' },
  ]
}

async function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number, text: string, headers: Headers }> {
  await startLocalProxyIfNeeded(API)
  const res = await fetch(`${API}${path}`, { method, headers, body })
  return { status: res.status, text: await res.text(), headers: res.headers }
}

// A websocket upgrade over HTTP/1.1, as the CLI sends it, so the edge treats it as one (fetch cannot send Upgrade).
function upgrade(path: string, headers: Record<string, string>): Promise<{ status: number, contentType: string, text: string }> {
  const url = new URL(`${API}${path}`)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'GET',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    request.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 0, contentType: '', text: '' })
    })
    request.on('response', (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), text }))
    })
    request.on('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('upgrade timed out')))
    request.end()
  })
}

test.describe.serial('contract', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('contract')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/IdempotencyMiddleware.cs InvokeAsync (IDEMPOTENCY_KEY_REQUIRED)
  test('CON-03 each of the twelve creates without Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const creates = twelveCreates()
    expect(creates.length).toBe(12)
    for (const create of creates) {
      const reply = await call(create.as, 'POST', create.path, {})
      log(`CON-03 ${create.path} → ${reply.status} ${reply.text.slice(0, 120)}`)
      expectError(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED')
    }
  })

  // titan-ops architecture/http-contract.md#error-envelope — { status, title, code }
  test('CON-04 a body that breaks the validator is 400 {status, title, code: VALIDATION_ERROR}', async () => {
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name: '', clusterId: '' }, randomUUID())
    expectError(reply, 400, 'VALIDATION_ERROR')
    const body = bodyOf(reply)
    expect(body.status).toBe(400)
    expect(typeof body.title).toBe('string')
  })

  // OpenViCloud/titan-control-plane:Titan.Host/Program.cs (AddJwtBearer) — JWT bearer on every non-anonymous route
  test('CON-05 no token or a broken token is 401', async () => {
    expect((await raw('GET', '/v1/tenant', {})).status).toBe(401)
    expect((await raw('GET', '/v1/tenant', { Authorization: 'Bearer not-a-token' })).status).toBe(401)
  })

  // Roles("platform-admin") on every admin endpoint (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/*,
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/ListTenantsEndpoint.cs)
  test('CON-06 beta-user on admin routes is 403', async () => {
    for (const path of ['/v1/admin/vms', '/v1/admin/networks', '/v1/admin/audit-log', '/v1/tenants', '/v1/admin/billing/receivables']) {
      const reply = await call('tenant', 'GET', path)
      log(`CON-06 ${path} → ${reply.status}`)
      expectStatus(reply, 403)
    }
  })

  // titan-ops architecture/provider-and-worker.md#provider-command-lease — /internal/* needs X-Internal-Token
  test('CON-07 /internal/* without X-Internal-Token is 401, even with a user token', async () => {
    const user = await headersOf('tenant')
    for (const path of ['/internal/reconcile/vms?clusterId=x', '/internal/reconcile/networks?clusterId=x']) {
      const anonymous = await raw('GET', path, {})
      const withUser = await raw('GET', path, user)
      log(`CON-07 ${path} → ${anonymous.status} / ${withUser.status}`)
      expect(anonymous.status).toBe(401)
      expect(withUser.status).toBe(401)
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Host/Program.cs (AddCors, policy corsPolicyName) — Cors:AllowedOrigins (portal, admin, site of the env)
  test('CON-08 CORS preflight allows the portal and admin origins and not a stranger', async () => {
    const preflight = (origin: string) => raw('OPTIONS', '/v1/tenant', {
      Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    })
    for (const origin of [new URL(PORTAL).origin, new URL(ADMIN).origin]) {
      const reply = await preflight(origin)
      log(`CON-08 ${origin} → ${reply.status} allow-origin=${reply.headers.get('access-control-allow-origin')}`)
      expect(reply.headers.get('access-control-allow-origin')).toBe(origin)
    }
    const stranger = await preflight('https://rg-stranger.example')
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull()
  })

  // titan-ops architecture/platform-infra.md — the release environment serves api, portal and admin over TLS on its own names
  // titan-ops architecture/http-contract.md#error-envelope — error bodies declare their length; the edge turns a refused
  // upgrade answered chunked into its own 502. OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs
  // HandleAsync (GetVmShellTargetQuery) → OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs RequireVmAsync (VM_NOT_FOUND)
  test('CON-12 a refused websocket upgrade reaches the client with its JSON code, not the edge 502', async () => {
    const reply = await upgrade(`/v1/tenant/vms/${randomUUID()}/ssh`, await headersOf('tenant'))
    log(`CON-12 → ${reply.status} ${reply.contentType} ${reply.text.slice(0, 200)}`)
    expect(reply.status).toBe(404)
    expect(reply.contentType).toContain('application/json')
    expect(JSON.parse(reply.text).code).toBe('VM_NOT_FOUND')
  })

  test('CON-09 TLS certificates are valid for the api, portal and admin names, with more than 14 days left', async () => {
    const hosts = [API, PORTAL, ADMIN].map((u) => new URL(u))
    test.skip(hosts.some((h) => h.protocol !== 'https:'), 'N/A: this env serves plain HTTP (dev)')
    for (const host of hosts) {
      const certificate = await new Promise<tls.PeerCertificate>((resolve, reject) => {
        const socket = tls.connect({ host: host.hostname, port: 443, servername: host.hostname }, () => {
          resolve(socket.getPeerCertificate())
          socket.end()
        })
        socket.on('error', reject)
      })
      const daysLeft = (new Date(certificate.valid_to).getTime() - Date.now()) / 86_400_000
      log(`CON-09 ${host.hostname} valid_to=${certificate.valid_to} (${Math.floor(daysLeft)} days)`)
      expect(daysLeft).toBeGreaterThan(14)
    }
  })
})
