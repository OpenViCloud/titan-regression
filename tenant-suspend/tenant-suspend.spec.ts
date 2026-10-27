import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { cleanUp } from './clean-up'
import { bodyOf, call, expectStatus, get, log, newKey, startLog } from './api'
import { RUN, envOf, nameOf } from './fixtures'
import { callWithToken, newSecret } from './token'

// Cases SUS-01..04 of plan.md. beta-user's tenant is Suspended for the length of this module only:
// afterAll puts it back to Active whatever happened.
test.describe.serial('tenant-suspend', () => {
  let tenantId = ''
  let suspended = false
  // SUS-04: an API token made while the tenant is still Active, deleted in afterAll once it is Active again.
  const tokenSecret = newSecret()
  let tokenId = ''

  async function setStatus(status: string): Promise<void> {
    const reply = await call('admin', 'PATCH', `/v1/tenants/${tenantId}/status`, { status })
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('tenant-suspend')
    useBrowser(browser)
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    expect(tenant.status, 'start from an Active tenant').toBe('Active')
    const created = await call('tenant', 'POST', '/v1/tenant/api-tokens', { name: nameOf('tok-sus'), token: tokenSecret, expiresInDays: 30 }, newKey())
    expectStatus(created, 201)
    tokenId = bodyOf(created).apiTokenId
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = []
    if (suspended) {
      steps.push(['beta-user Active again', async () => {
        await setStatus('Active')
        log('afterAll: beta-user Active again')
      }])
    }
    if (tokenId !== '') {
      steps.push([`delete token ${tokenId}`, async () => {
        const deleted = await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${tokenId}`)
        expect([204, 404], `${deleted.url} → ${deleted.text.slice(0, 200)}`).toContain(deleted.status)
      }])
    }
    steps.push(['close sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantStatusEndpoint.cs (Configure: Patch("v1/tenants/{tenantId:guid}/status");
  // HandleAsync: SendNoContentAsync);
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/TenantResolutionMiddleware.cs InvokeAsync (isWrite ⇒ TENANT_SUSPENDED) (a middleware 403 is {code, message}: OpenViCloud/titan-ops:docs/architecture/http-contract.md, named exceptions) — writes refused, reads pass
  test('SUS-01 a suspended tenant reads but cannot write: 403 TENANT_SUSPENDED', async () => {
    suspended = true
    await setStatus('Suspended')
    const tenant = await get('tenant', '/v1/tenant')
    expect(tenant.status).toBe('Suspended')
    expectStatus(await call('tenant', 'GET', '/v1/tenant/vms'), 200)
    const { clusterId } = await envOf()
    const write = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-susnet-${RUN}`, clusterId, cidr: '10.88.0.0/24' }, newKey())
    log(`SUS-01 write → ${write.status} ${write.text.slice(0, 200)}`)
    expectStatus(write, 403)
    expect(bodyOf(write).code).toBe('TENANT_SUSPENDED')
    const networks = await get('tenant', '/v1/tenant/networks') as any[]
    expect(networks.some((n) => n.name === `rg-susnet-${RUN}`)).toBe(false)
  })

  // OpenViCloud/titan-ops:docs/features/tenant/design.md#tenant-status-repeats
  test('SUS-02 suspending again is 204', async () => {
    await setStatus('Suspended')
    expect((await get('tenant', '/v1/tenant')).status).toBe('Suspended')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/ApiTokenAuthenticationHandler.cs (HandleAuthenticateAsync: the token is the
  // member's `sub`, so TenantResolutionMiddleware applies suspension unchanged); OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/
  // TenantResolutionMiddleware.cs InvokeAsync (isWrite ⇒ TENANT_SUSPENDED) · OpenViCloud/titan-ops:docs/features/public-api/design.md#api-token
  test('SUS-04 an API token of the suspended tenant reads 200 and its write is 403 TENANT_SUSPENDED', async () => {
    const read = await callWithToken(tokenSecret, 'GET', '/v1/tenant')
    expectStatus(read, 200)
    expect(bodyOf(read).status).toBe('Suspended')
    const write = await callWithToken(tokenSecret, 'POST', '/v1/tenant/api-tokens', { name: nameOf('tok-sus2'), token: newSecret(), expiresInDays: 30 }, newKey())
    log(`SUS-04 read → ${read.status}; write → ${write.status} ${write.text.slice(0, 200)}`)
    expectStatus(write, 403)
    expect(bodyOf(write).code).toBe('TENANT_SUSPENDED')
  })

  test('SUS-03 Active again is 204 and writes pass', async () => {
    await setStatus('Active')
    suspended = false
    expect((await get('tenant', '/v1/tenant')).status).toBe('Active')
    // A write that changes nothing lasting: a create refused by its validator gets past the tenant gate.
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name: '', clusterId: '' }, newKey())
    log(`SUS-03 write → ${reply.status} ${reply.text.slice(0, 200)}`)
    expectStatus(reply, 400)
    expect(bodyOf(reply).code).toBe('VALIDATION_ERROR')
  })
})
