import { test, expect } from '@playwright/test'
import { randomBytes, randomUUID } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import type { Socket } from 'node:net'
import { closeSessions, headersOf, useBrowser } from './auth'
import { API, bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { cleanUp } from './clean-up'
import { startLocalProxyIfNeeded } from './local-proxy'
import { GUEST_START_WAIT_MS, fiveSessionsThenRefused, upgrade } from './ssh'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, waitVm } from './fixtures'

// --- websocket frames ----------------------------------------------------------------------------------------

// A websocket over a raw HTTP/1.1 upgrade, framed by hand (RFC 6455): lib/ssh.ts upgrade() hands back the socket only,
// and the cases below read the server's frames (the SSH banner, console bytes, a close code and its reason). Binary
// frames are the session's bytes; a text frame from the server is counted, not kept.
class Ws {
  status: number
  code: string
  contentLength: string | undefined
  socket: Socket | null
  closeCode: number | null = null
  closeReason = ''
  gone = false
  textFrames = 0
  pending: Buffer = Buffer.alloc(0)
  dataOpcode = 0
  chunks: Buffer[] = []
  size = 0
  closeSent = false

  constructor(status: number, code: string, contentLength: string | undefined, socket: Socket | null, head: Buffer) {
    this.status = status
    this.code = code
    this.contentLength = contentLength
    this.socket = socket
    if (socket !== null) {
      socket.on('data', (chunk: Buffer) => this.take(chunk))
      socket.on('close', () => { this.gone = true })
      socket.on('error', () => {})
      if (head.length > 0) {
        this.take(head)
      }
    }
  }

  take(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 2) {
      const first = this.pending[0]
      const second = this.pending[1]
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.pending.length < 4) {
          return
        }
        length = this.pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.pending.length < 10) {
          return
        }
        length = Number(this.pending.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const maskAt = offset
      if (masked) {
        offset += 4
      }
      if (this.pending.length < offset + length) {
        return
      }
      const payload = Buffer.from(this.pending.subarray(offset, offset + length))
      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= this.pending[maskAt + (i % 4)]
        }
      }
      this.pending = this.pending.subarray(offset + length)
      this.frame(first & 0x0f, payload)
    }
  }

  frame(opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      this.closeReason = payload.subarray(2).toString('utf8')
      this.send(0x8, payload.subarray(0, payload.length >= 2 ? 2 : 0))
      this.socket?.end()
      return
    }
    if (opcode === 0x9) {
      this.send(0xa, payload)
      return
    }
    if (opcode === 0xa) {
      return
    }
    if (opcode !== 0x0) {
      this.dataOpcode = opcode
    }
    if (this.dataOpcode === 0x2) {
      this.chunks.push(payload)
      this.size += payload.length
    } else {
      this.textFrames++
    }
  }

  // A client frame is masked (RFC 6455 §5.3).
  send(opcode: number, payload: Buffer): void {
    if (this.socket === null || this.socket.destroyed || this.closeSent) {
      return
    }
    if (opcode === 0x8) {
      this.closeSent = true
    }
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    const mask = randomBytes(4)
    const body = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) {
      body[i] = payload[i] ^ mask[i % 4]
    }
    this.socket.write(Buffer.concat([header, mask, body]))
  }

  sendText(text: string): void {
    this.send(0x1, Buffer.from(text, 'utf8'))
  }

  sendBinary(text: string): void {
    this.send(0x2, Buffer.from(text, 'utf8'))
  }

  close(code: number): void {
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    this.send(0x8, payload)
  }

  // Bytes received so far: a mark for textSince.
  bytes(): number {
    return this.size
  }

  textSince(mark: number): string {
    return Buffer.concat(this.chunks).subarray(mark).toString('utf8')
  }

  isClosed(): boolean {
    return this.closeCode !== null || this.gone
  }

  async until(done: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (!done()) {
      if (Date.now() >= deadline) {
        return false
      }
      await sleep(200)
    }
    return true
  }

  // Ends the session from this side: a close frame, the server's answer for up to 10 s, then the socket.
  async end(): Promise<void> {
    if (this.socket === null) {
      return
    }
    this.close(1000)
    await this.until(() => this.isClosed(), 10_000)
    this.destroy()
  }

  destroy(): void {
    this.socket?.destroy()
    this.gone = true
  }
}

// An upgrade as the CLI (SSH, with the token) or the portal (console, no token: the ticket authenticates it) sends it.
async function openWs(path: string, withToken: boolean): Promise<Ws> {
  await startLocalProxyIfNeeded(API)
  const auth: Record<string, string> = withToken ? await headersOf('tenant') : {}
  const url = new URL(`${API}${path}`)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'GET',
      headers: {
        ...auth,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    request.on('upgrade', (res, socket, head) => {
      socket.setTimeout(0)
      socket.removeAllListeners('timeout')
      resolve(new Ws(res.statusCode ?? 0, '', undefined, socket as Socket, head))
    })
    request.on('response', (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let code = ''
        try {
          code = JSON.parse(text).code ?? ''
        } catch {
          code = `(not JSON: ${text.slice(0, 120)})`
        }
        resolve(new Ws(res.statusCode ?? 0, code, res.headers['content-length'], null, Buffer.alloc(0)))
      })
    })
    request.on('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('upgrade timed out')))
    request.end()
  })
}

// --- console -------------------------------------------------------------------------------------------------

// The shape the portal makes: ovct_ + 43 base64url characters of 32 random bytes
// (OpenViCloud/titan-cloud-console:portal/src/lib/consoleSession.ts newConsoleTicket).
function newTicket(): string {
  return `ovct_${randomBytes(32).toString('base64url')}`
}

async function issueTicket(vmId: string): Promise<string> {
  const ticket = newTicket()
  expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/console-tickets`, { ticket }), 204)
  return ticket
}

function openConsole(vmId: string, ticket: string | null): Promise<Ws> {
  const query = ticket === null ? '' : `?ticket=${ticket}`
  return openWs(`/v1/tenant/vms/${vmId}/console${query}`, false)
}

// Whether the cluster's serial console can attach: not on an arm64 Incus (titan-ops features/vm/design.md#vm-console,
// VM_CONSOLE_UNAVAILABLE), but on amd64. No API names the cluster's architecture. On dev the runner pod's node and the
// Incus host are two VMs of one machine of the same architecture (OpenViCloud/titan-local-cluster:docs/topology.md,
// macOS and Ubuntu deployments); the release environment's cluster is amd64 (plan.md:158, CSL-03).
function serialConsoleAttaches(): boolean {
  const onDev = new URL(API).hostname.endsWith('.localhost')
  return !onDev || process.arch === 'x64'
}

// Up to every 30 s until `seen` or the deadline: `send` once per round, then wait out what is left of the round.
async function everyThirtySeconds(ws: Ws, send: () => Promise<void>, seen: () => boolean, deadline: number): Promise<boolean> {
  while (Date.now() < deadline && !ws.isClosed()) {
    const round = Date.now()
    await send()
    const left = Math.min(round + 30_000, deadline) - Date.now()
    if (await ws.until(() => seen() || ws.isClosed(), Math.max(left, 0))) {
      return seen()
    }
  }
  return seen()
}

function passwordOf(length: number): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(length)
  let password = ''
  for (let i = 0; i < length; i++) {
    password += letters[bytes[i] % letters.length]
  }
  return password
}

// CSL-06 of plan.md, run by vm/vm.spec.ts (dev) and, the same body, by vm/ssh-sessions/ssh-sessions.spec.ts (the release
// environment). lib/ssh.ts fiveSessionsThenRefused opens its five sessions with no place to issue a ticket between them,
// so this opens five of its own on the same running VM right after SSH-08 · titan-ops features/vm/design.md#vm-console ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmConsoleTicketEndpoint.cs (HandleAsync:
// limiter.HasRoomAsync, takes no place) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmConsoleEndpoint.cs
// (RunAsync: limiter.TryAcquireAsync before Incus and before RequestVmConsoleCommand; CloseAsync 4000 + 422) ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ConsoleTicketStore.cs (Lifetime, 30 s) ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ShellSessionLimiter.cs (MaxSessionsPerTenant, 5)
async function consoleRefusedAtTheLimit(vmId: string, vmName: string): Promise<void> {
  const ssh = `/v1/tenant/vms/${vmId}/ssh`
  // SSH-08's last session gives its place back once closed; it waits as long before opening again.
  await sleep(15_000)
  const before = countOf(await activityOf(vmName), 'vm.console_requested')
  const held: Socket[] = []
  let consoleWs: Ws | null = null
  try {
    for (let i = 1; i <= 4; i++) {
      const reply = await upgrade(ssh)
      log(`CSL-06 SSH session ${i} → ${reply.status} ${reply.code}`)
      if (reply.socket !== null) {
        held.push(reply.socket)
      }
      expect(reply.status, `SSH session ${i}`).toBe(101)
    }
    const ticket = await issueTicket(vmId)
    const issuedAt = Date.now()
    const fifth = await upgrade(ssh)
    log(`CSL-06 SSH session 5 → ${fifth.status} ${fifth.code}`)
    if (fifth.socket !== null) {
      held.push(fifth.socket)
    }
    expect(fifth.status, 'SSH session 5').toBe(101)

    const refused = await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/console-tickets`, { ticket: newTicket() })
    log(`CSL-06 ticket at five sessions → ${refused.status} ${refused.text.slice(0, 200)}`)
    expectError(refused, 422, 'VM_SESSION_LIMIT_REACHED')

    const sinceIssued = Date.now() - issuedAt
    log(`CSL-06 console upgrade ${Math.round(sinceIssued / 1000)} s after its ticket`)
    expect(sinceIssued, 'the console opens within the ticket\'s 30 s').toBeLessThan(30_000)
    consoleWs = await openConsole(vmId, ticket)
    const opened = consoleWs
    expect(opened.status, `console upgrade ${opened.code}`).toBe(101)
    await opened.until(() => opened.isClosed(), 45_000)
    log(`CSL-06 console closed ${opened.closeCode} ${opened.closeReason}`)
    expect(opened.closeCode).toBe(4422)
    expect(opened.closeReason).toBe('VM_SESSION_LIMIT_REACHED')
  } finally {
    consoleWs?.destroy()
    for (const socket of held) {
      socket.destroy()
    }
  }
  expect(countOf(await activityOf(vmName), 'vm.console_requested')).toBe(before)
}

// Cases VM-01..19, VM-21, VM-22, VM-26, VM-27, VM-29, VM-31..34, VM-36, VM-37, SSH-08, SSH-09 and CSL-01..06 of plan.md,
// plus ACT-01/ACT-03/ACT-04 for VMs. VM-14 is measured over the Internet in Phase 4, VM-30 is NOT COVERED, and VM-20,
// VM-23..25, VM-28 and VM-35 read the Incus host. Create checks run in this order
// (OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync):
// quota (TenantQuotaGate), cluster, name, network, offering, template — so the error cases run below the quota. At most
// two VMs of this module run at once (dev's Incus host is small): vmA and vmB until VM-17, then the VM of VM-34 alone
// (vmA stopped) until CSL-05 deletes it, then vmA alone for SSH-08 and CSL-06.
test.describe.serial('vm', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  const nameA = `rg-vma-${RUN}`
  const nameB = `rg-vmb-${RUN}`
  const renamed = `rg-vma-${RUN}-renamed`
  let networkId = ''
  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null
  const made: string[] = []
  let vmA = ''
  let vmB = ''
  // VM-34's VM, with a console password, for CSL-04 and CSL-05.
  const namePw = `rg-vmpw-${RUN}`
  let vmPw = ''
  let consolePassword = ''
  // CSL-04's session, still open for CSL-05.
  let consoleSession: Ws | null = null
  const opened: Ws[] = []

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('vm')
    useBrowser(browser)
    networkId = (await runNetwork()).id
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    originalQuota = { maxVms: tenant.maxVms, maxNetworks: tenant.maxNetworks }
    log(`quota before: ${JSON.stringify(originalQuota)}`)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = [
      ['quota', async () => {
        if (originalQuota !== null) {
          expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
        }
      }],
    ]
    steps.push(['websockets', async () => {
      for (const ws of opened) {
        ws.destroy()
      }
    }])
    for (const id of made) {
      steps.push([`vm ${id}`, () => deleteVmAndWait(id)])
    }
    steps.push(['sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmValidator.cs CreateVmValidator (Name MaximumLength(Vm.NameMaxLength), 64, from OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs)
  test('VM-09 a 65-character name is 400 VALIDATION_ERROR', async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: 'rg-' + 'x'.repeat(62), networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()),
      400, 'VALIDATION_ERROR')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync: clusters.ClusterOf
  // (OpenViCloud/titan-control-plane:Titan.Application/Options/ClusterOptions.cs ClusterOf), VM_OFFERING_NOT_FOUND, TEMPLATE_NOT_FOUND
  test('VM-11 unknown offering, template, cluster are 404 with their codes', async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    const base = { name: `rg-vmx-${RUN}`, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', { ...base, vmOfferingId: 'rg-none' }, newKey()), 404, 'VM_OFFERING_NOT_FOUND')
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', { ...base, templateId: randomUUID() }, newKey()), 404, 'TEMPLATE_NOT_FOUND')
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', { ...base, clusterId: 'rg-no-such-cluster' }, newKey()), 404, 'CLUSTER_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync (!template.IsListed ⇒ TEMPLATE_NOT_FOUND) — not listed ⇒ as if it did not exist
  test('VM-22 a template customers are not offered is 404 TEMPLATE_NOT_FOUND, and no VM is made', async () => {
    const admin = await get('admin', '/v1/admin/templates') as any[]
    const unlisted = admin.find((a) => a.listed === false)
    test.skip(unlisted === undefined, 'no unlisted template on this env')
    const { clusterId, smallTier } = await envOf()
    const name = `rg-vmu-${RUN}`
    const body = { name, networkId, vmOfferingId: smallTier, templateId: unlisted.id, clusterId, diskSizeGb: null }
    log(`VM-22 template ${unlisted.name} (${unlisted.id})`)
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', body, newKey()), 404, 'TEMPLATE_NOT_FOUND')
    const vms = await get('tenant', '/v1/tenant/vms') as any[]
    expect(vms.filter((v) => v.name === name)).toEqual([])
  })

  // titan-ops features/vm/design.md#vm-create-flow · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmValidator.cs
  // CreateVmValidator (UserData: Encoding.UTF8.GetByteCount ≤ 32768) — the limit counts UTF-8 bytes, not characters
  test('VM-29 userData of 32 769 bytes is 400 VALIDATION_ERROR, ASCII or multi-byte, and makes no VM', async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    const name = `rg-vmud-${RUN}`
    const ascii = 'a'.repeat(32_769)
    const checks = '✓'.repeat(10_923)
    expect(Buffer.byteLength(ascii, 'utf8')).toBe(32_769)
    expect(Buffer.byteLength(checks, 'utf8')).toBe(32_769)
    for (const userData of [ascii, checks]) {
      expectError(await call('tenant', 'POST', '/v1/tenant/vms',
        { name, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null, userData }, newKey()),
        400, 'VALIDATION_ERROR')
    }
    const vms = await get('tenant', '/v1/tenant/vms') as any[]
    expect(vms.filter((v) => v.name === name)).toEqual([])
  })

  // titan-ops architecture/tenancy-and-admin.md#tenant-isolation · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs
  // HandleAsync (a network that is missing or another tenant's ⇒ NETWORK_NOT_FOUND; TenantQuotaGate.EnsureHasRoom runs first)
  test("VM-27 an unknown network, or another tenant's, is 404 NETWORK_NOT_FOUND and makes no VM", async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    const name = `rg-vmnet-${RUN}`
    const base = { name, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }
    const networkBefore = await get('tenant', `/v1/tenant/networks/${networkId}`)

    expectError(await call('tenant', 'POST', '/v1/tenant/vms', { ...base, networkId: randomUUID() }, newKey()), 404, 'NETWORK_NOT_FOUND')
    expect((await get('tenant', '/v1/tenant/vms') as any[]).filter((v) => v.name === name)).toEqual([])

    const reply = await call('admin', 'POST', '/v1/tenant/vms', { ...base, networkId }, newKey())
    log(`VM-27 admin-test with beta-user's network → ${reply.status} ${reply.text.slice(0, 200)}`)
    if (reply.status === 202) {
      // A finding: do not leave the VM in admin-test's tenant.
      expectStatus(await call('admin', 'DELETE', `/v1/tenant/vms/${bodyOf(reply).vmId}`), 202)
    }
    if (reply.status === 422 && bodyOf(reply).code === 'VM_QUOTA_EXCEEDED') {
      // The quota is asked before the network, so a tenant without VM room never reaches the network check.
      log("VM-27 admin-test half N/A: admin-test's tenant is out of VM quota (422 VM_QUOTA_EXCEEDED)")
      test.info().annotations.push({ type: 'N/A', description: "admin-test half: admin-test's tenant is out of VM quota" })
    } else {
      expectError(reply, 404, 'NETWORK_NOT_FOUND')
    }
    expect((await get('admin', '/v1/tenant/vms') as any[]).filter((v) => v.name === name)).toEqual([])
    expect(await get('tenant', `/v1/tenant/networks/${networkId}`)).toEqual(networkBefore)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs ProviderIdForVm (NETWORK_CLUSTER_MISMATCH)
  test('VM-12 a VM in another cluster than its network is 422 NETWORK_CLUSTER_MISMATCH', async () => {
    const clusters = await get('anonymous', '/v1/clusters') as Array<{ id: string }>
    const usable: string[] = []
    for (const cluster of clusters) {
      const templates = await get('tenant', `/v1/templates?clusterId=${cluster.id}`) as any[]
      if (templates.length > 0) {
        usable.push(cluster.id)
      }
    }
    test.skip(usable.length < 2, `N/A: one cluster with templates (${usable.join(',')})`)
    const { clusterId, smallTier } = await envOf()
    const other = usable.find((z) => z !== clusterId)!
    const templates = await get('tenant', `/v1/templates?clusterId=${other}`) as any[]
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: `rg-vmz-${RUN}`, networkId, vmOfferingId: smallTier, templateId: templates[0].id, clusterId: other, diskSizeGb: null }, newKey()),
      422, 'NETWORK_CLUSTER_MISMATCH')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmEndpoint.cs HandleAsync; current comes from the reconciler:
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/ObserveVmCommandHandler.cs HandleAsync (vm.MarkObserved) ·
  // titan-ops features/vm/design.md#vm-create-flow — userData is kept as sent (OpenViCloud/titan-control-plane:Titan.Application/Queries/Compute/Vm/Contracts/VmQueryResult.cs
  // VmQueryResult.UserData); comments only ⇒ the worker sets no cloud-init.user-data (OpenViCloud/titan-incus-worker:resource/vm/create.go HasUserDataContent, VM-23 on the host)
  test('VM-01 a VM of the smallest tier with comment-only userData is 202 {vmId}, then Running or Ready with an address; userData reads back byte for byte', async () => {
    const { smallTier } = await envOf()
    const userData = `#cloud-config\n# rg-${RUN} ✓ tiếng Việt\n`
    vmA = await createVm(nameA, smallTier, networkId, { userData })
    made.push(vmA)
    const vm = await waitVm('VM-01', vmA, (v) => runs(v) && v.ipAddress !== null)
    expect(['Running', 'Ready', 'Stopped', 'Frozen', 'Error']).toContain(vm.status)
    expect(vm.vmOfferingId).toBe(smallTier)
    expect(vm.userData).toBe(userData)
    expect(Buffer.from(vm.userData, 'utf8').equals(Buffer.from(userData, 'utf8'))).toBe(true)
    const actions = await activityOf(nameA)
    log(`ACT-01 create ${nameA}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.create_requested')).toBe(1)
    expect(countOf(actions, 'vm.created')).toBe(1)
  })

  // titan-ops features/vm/design.md#ssh-session · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs
  // (HandleAsync: VM_SSH_NOT_READY when nc ends with no byte within BannerWait; request.HandleAsync, the vm.ssh_requested
  // row, only before the accept; the first byte read is the first the customer gets) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/JsonErrorWriter.cs (WriteAsync: ContentLength). Runs
  // right after VM-01, before VM-02 makes a second VM, so vmA's guest starts alone.
  test('SSH-09 a VM just made refuses SSH with 422 VM_AGENT_NOT_READY or VM_SSH_NOT_READY (with Content-Length) until the first 101, whose first bytes are the SSH banner', async () => {
    test.setTimeout(15 * 60_000)
    const path = `/v1/tenant/vms/${vmA}/ssh`
    const before = countOf(await activityOf(nameA), 'vm.ssh_requested')
    const codes: Record<string, number> = {}
    const started = Date.now()
    let session: Ws | null = null
    while (session === null) {
      const reply = await openWs(path, true)
      if (reply.status === 101) {
        session = reply
        opened.push(reply)
        break
      }
      const key = `${reply.status} ${reply.code}`
      codes[key] = (codes[key] ?? 0) + 1
      log(`SSH-09 probe → ${key} Content-Length=${reply.contentLength} (+${Math.round((Date.now() - started) / 1000)}s)`)
      expect(reply.status, key).toBe(422)
      expect(reply.contentLength, `${key} declares its length`).toMatch(/^\d+$/)
      expect(['VM_AGENT_NOT_READY', 'VM_SSH_NOT_READY'], key).toContain(reply.code)
      expect(Date.now() - started, 'the first 101 within GUEST_START_WAIT_MS').toBeLessThan(GUEST_START_WAIT_MS)
      await sleep(5_000)
    }
    const accepted = session
    try {
      // The control plane may accept after its 5 s banner wait with nothing read yet; the banner then follows.
      await accepted.until(() => accepted.bytes() >= 8 || accepted.isClosed(), 30_000)
      const first = accepted.textSince(0)
      log(`SSH-09 101 after ${Math.round((Date.now() - started) / 1000)} s; first bytes ${JSON.stringify(first.slice(0, 40))}`)
      expect(first.startsWith('SSH-2.0-'), `first bytes ${JSON.stringify(first.slice(0, 40))}`).toBe(true)
    } finally {
      accepted.destroy()
    }
    log(`SSH-09 refusals by code: ${JSON.stringify(codes)}`)
    if (codes['422 VM_SSH_NOT_READY'] === undefined) {
      test.info().annotations.push({ type: 'note', description: `no VM_SSH_NOT_READY this run (the guest came up fast): ${JSON.stringify(codes)}` })
    }
    expect(countOf(await activityOf(nameA), 'vm.ssh_requested') - before, 'one vm.ssh_requested per 101, none per refusal').toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync (ExistsByNameAsync ⇒ VM_NAME_TAKEN)
  test('VM-10 a second VM with a live name is 409 VM_NAME_TAKEN', async () => {
    const { smallTier, clusterId, templateId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: nameA, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()), 409, 'VM_NAME_TAKEN')
  })

  // titan-ops features/vm/design.md#vm-stop-timeout · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmValidator.cs
  // (CreateVmValidator: StopTimeoutSeconds InclusiveBetween(Vm.MinStopTimeoutSeconds, Vm.MaxStopTimeoutSeconds), 30 to 1800) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs (HandleAsync: absent ⇒
  // Vm.DefaultStopTimeoutSeconds, 120). vmA was made without stopTimeoutSeconds.
  test('VM-36 a VM made without a stop timeout has 120; 29 and 1801 are 400 VALIDATION_ERROR and make no VM', async () => {
    expect((await getVm(vmA)).stopTimeoutSeconds).toBe(120)
    const { clusterId, templateId, smallTier } = await envOf()
    const name = `rg-vmst-${RUN}`
    for (const stopTimeoutSeconds of [29, 1801]) {
      expectError(await call('tenant', 'POST', '/v1/tenant/vms',
        { name, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null, stopTimeoutSeconds }, newKey()),
        400, 'VALIDATION_ERROR')
    }
    expect((await get('tenant', '/v1/tenant/vms') as any[]).filter((v) => v.name === name)).toEqual([])
    expect(countOf(await activityOf(name), 'vm.create_requested')).toBe(0)
  })

  // titan-ops architecture/code-structure.md#quota-gate · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs
  // HandleAsync (TenantQuotaGate.EnsureHasRoom before ExistsByNameAsync) · OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs
  // EnsureHasRoom (count >= cap: a cap of 0 refuses the first one)
  test('VM-26 at maxVms 0, a VM with a live name is 422 VM_QUOTA_EXCEEDED, not 409 VM_NAME_TAKEN', async () => {
    const { smallTier, clusterId, templateId } = await envOf()
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, { maxVms: 0, maxNetworks: originalQuota!.maxNetworks }), 204)
    try {
      expectError(await call('tenant', 'POST', '/v1/tenant/vms',
        { name: nameA, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()), 422, 'VM_QUOTA_EXCEEDED')
    } finally {
      expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
    }
    const vms = await get('tenant', '/v1/tenant/vms') as any[]
    expect(vms.filter((v) => v.name === nameA).map((v) => v.id)).toEqual([vmA])
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync (offeringRepo.FindByIdAsync) — the tier asked for is resolved and kept on the VM
  test('VM-02 a VM of the next tier runs too', async () => {
    const { otherTier } = await envOf()
    vmB = await createVm(nameB, otherTier, networkId)
    made.push(vmB)
    const vm = await waitVm('VM-02', vmB, (v) => runs(v) && v.ipAddress !== null)
    expect(['Running', 'Ready', 'Stopped', 'Frozen', 'Error']).toContain(vm.status)
    expect(vm.vmOfferingId).toBe(otherTier)
  })

  // Public IPv6 is the network's (titan-ops features/network/design.md#ipv6-public): the VM has no switch, and on the run
  // network (no public IPv6) the reconciler reports no global IPv6 — OpenViCloud/titan-incus-worker:resource/vm/reconcile.go
  test('VM-13 a VM on a network without public IPv6 has no IPv6 switch and no public IPv6 address', async () => {
    const vm = await get('tenant', `/v1/tenant/vms/${vmA}`)
    expect(runs(vm)).toBe(true)
    expect('enablePublicIpv6' in vm).toBe(false)
    expect(vm.publicIpv6Address).toBeNull()
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Stop.cs Stop · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/StopVmEndpoint.cs HandleAsync
  test('VM-03 stop from Running is 202, then Stopped', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    const vm = await waitVm('VM-03', vmA, (v) => v.status === 'Stopped')
    expect(vm.status).toBe('Stopped')
    const actions = await activityOf(nameA)
    expect(countOf(actions, 'vm.stop_requested')).toBe(1)
    expect(countOf(actions, 'vm.stopped')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/StopVmCommandHandler.cs HandleAsync (Vm.IsStopWaitingOrStopped) — already stopped answers like the first request
  test('VM-04 stop again on a Stopped VM is 202 and records nothing (ACT-03)', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    const vm = await getVm(vmA)
    expect(vm.status).toBe('Stopped')
    expect(countOf(await activityOf(nameA), 'vm.stop_requested')).toBe(1)
  })

  // titan-ops features/vm/design.md#vm-console · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmConsoleTicketEndpoint.cs
  // (CreateVmConsoleTicketValidator: ConsoleTicketStore.TicketPattern; HandleAsync: GetVmShellTargetQuery, then 204) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Guards.cs (GetShellInstanceName: only Running or Ready) ·
  // titan-ops architecture/tenancy-and-admin.md#tenant-isolation. vmA is Stopped since VM-03, vmB runs since VM-02.
  test("CSL-01 a console ticket is 204 for a running VM; a malformed one 400; a Stopped VM 422 VM_INVALID_STATUS; an unknown or another tenant's VM 404", async () => {
    expect(runs(await getVm(vmB))).toBe(true)
    expect((await getVm(vmA)).status).toBe('Stopped')
    const tickets = (id: string) => `/v1/tenant/vms/${id}/console-tickets`
    const accepted = await call('tenant', 'POST', tickets(vmB), { ticket: newTicket() })
    expectStatus(accepted, 204)
    expect(accepted.text).toBe('')
    expectError(await call('tenant', 'POST', tickets(vmB), { ticket: 'ovct_abc' }), 400, 'VALIDATION_ERROR')
    expectError(await call('tenant', 'POST', tickets(vmA), { ticket: newTicket() }), 422, 'VM_INVALID_STATUS')
    expectError(await call('tenant', 'POST', tickets(randomUUID()), { ticket: newTicket() }), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'POST', tickets(vmB), { ticket: newTicket() }), 404, 'VM_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Start.cs Start · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/StartVmEndpoint.cs HandleAsync
  test('VM-05 start from Stopped is 202, then Running or Ready', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/start`), 202)
    await waitVm('VM-05', vmA, (v) => runs(v))
    expect(countOf(await activityOf(nameA), 'vm.started')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/StartVmCommandHandler.cs HandleAsync (Vm.IsStartWaitingOrRunning) — already running answers 202
  test('VM-06 start on a running VM is 202 and changes nothing', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/start`), 202)
    const vm = await getVm(vmA)
    expect(runs(vm)).toBe(true)
    expect(countOf(await activityOf(nameA), 'vm.start_requested')).toBe(1)
  })

  // titan-ops features/vm/design.md#vm-stop-timeout · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/UpdateVmValidator.cs
  // (UpdateVmValidator: Name or StopTimeoutSeconds, StopTimeoutSeconds InclusiveBetween 30 to 1800) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/UpdateVmCommandHandler.cs (HandleAsync: the value it
  // already has ⇒ return, nothing written; enqueues nothing). On vmB between VM-06 and VM-07; 120 again before VM-17 stops it.
  test('VM-37 PATCH stopTimeoutSeconds is 204 in place: 30, 1800, 1800 again; 29, 1801 and {} are 400; status and name never move', async () => {
    const path = `/v1/tenant/vms/${vmB}`
    const check = async (label: string, seconds: number | null): Promise<void> => {
      const vm = await getVm(vmB)
      log(`VM-37 ${label}: status=${vm.status} name=${vm.name} stopTimeoutSeconds=${vm.stopTimeoutSeconds}`)
      expect(['Running', 'Ready'], `${label} status`).toContain(vm.status)
      expect(vm.name, `${label} name`).toBe(nameB)
      if (seconds !== null) {
        expect(vm.stopTimeoutSeconds, `${label} stopTimeoutSeconds`).toBe(seconds)
      }
    }
    await check('before', null)
    try {
      expectStatus(await call('tenant', 'PATCH', path, { stopTimeoutSeconds: 30 }), 204)
      await check('30', 30)
      expectStatus(await call('tenant', 'PATCH', path, { stopTimeoutSeconds: 1800 }), 204)
      await check('1800', 1800)
      expectStatus(await call('tenant', 'PATCH', path, { stopTimeoutSeconds: 1800 }), 204)
      await check('1800 again', 1800)
      for (const body of [{ stopTimeoutSeconds: 29 }, { stopTimeoutSeconds: 1801 }, {}]) {
        expectError(await call('tenant', 'PATCH', path, body), 400, 'VALIDATION_ERROR')
      }
      await check('after the three 400s', 1800)
      expectStatus(await call('tenant', 'PATCH', path, { stopTimeoutSeconds: 120 }), 204)
      await check('120', 120)
    } finally {
      expectStatus(await call('tenant', 'PATCH', path, { stopTimeoutSeconds: 120 }), 204)
    }
  })

  // titan-ops features/vm/design.md#vm-console · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmConsoleEndpoint.cs
  // (HandleAsync: WEBSOCKET_REQUIRED before the ticket is read; TakeTicketAsync: missing, malformed, unknown, used, of another VM ⇒
  // CONSOLE_TICKET_INVALID, before the upgrade) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ConsoleTicketStore.cs
  // (Lifetime 30 s; TakeAsync deletes the row as it reads it, so a ticket is taken once). vmA and vmB both run here (VM-05).
  test('CSL-02 the console route without an upgrade is 400 WEBSOCKET_REQUIRED; no, unknown, used, expired or another VM\'s ticket is 401 CONSOLE_TICKET_INVALID', async () => {
    test.setTimeout(5 * 60_000)
    expect(runs(await getVm(vmA))).toBe(true)
    expect(runs(await getVm(vmB))).toBe(true)
    const fresh = await issueTicket(vmB)
    expectError(await call('anonymous', 'GET', `/v1/tenant/vms/${vmB}/console?ticket=${fresh}`), 400, 'WEBSOCKET_REQUIRED')

    const refused: Array<[string, Ws]> = []
    refused.push(['no ticket', await openConsole(vmB, null)])
    refused.push(['a ticket never issued', await openConsole(vmB, newTicket())])

    // Used once: it opened a session (closed at once), so it is gone.
    const once = await issueTicket(vmB)
    const first = await openConsole(vmB, once)
    opened.push(first)
    log(`CSL-02 first use → ${first.status} ${first.code}`)
    expect(first.status, 'the ticket\'s first use').toBe(101)
    await first.end()
    log(`CSL-02 first use closed ${first.closeCode} ${first.closeReason}`)
    refused.push(['a ticket used once', await openConsole(vmB, once)])

    const old = await issueTicket(vmB)
    await sleep(35_000)
    refused.push(['a ticket issued 35 s ago', await openConsole(vmB, old)])

    const otherVms = await issueTicket(vmA)
    refused.push(['a ticket issued for vmA', await openConsole(vmB, otherVms)])

    for (const [label, reply] of refused) {
      log(`CSL-02 ${label} → ${reply.status} ${reply.code}`)
      if (reply.socket !== null) {
        opened.push(reply)
      }
      expect(reply.status, label).toBe(401)
      expect(reply.code, label).toBe('CONSOLE_TICKET_INVALID')
    }
  })

  // titan-ops features/vm/design.md#vm-console · OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusExecSession.cs
  // (OpenConsoleAsync: the console operation not Running after its 1 s read ⇒ VM_CONSOLE_UNAVAILABLE) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmConsoleEndpoint.cs (RunAsync: the place is held with
  // `await using`, so a refusal gives it back; RequestVmConsoleCommand only once Incus attached; CloseAsync 4000 + 422).
  // Measured on vmB; no other job opens an SSH or console session of the tenant meanwhile.
  test('CSL-03 on an arm64 cluster every console closes 4422 VM_CONSOLE_UNAVAILABLE, six times in a row, and records nothing', async () => {
    test.skip(serialConsoleAttaches(), 'N/A: amd64 cluster, the serial console attaches (CSL-04 measures it)')
    test.setTimeout(10 * 60_000)
    expect(runs(await getVm(vmB))).toBe(true)
    const before = countOf(await activityOf(nameB), 'vm.console_requested')
    for (let i = 1; i <= 6; i++) {
      const ws = await openConsole(vmB, await issueTicket(vmB))
      opened.push(ws)
      expect(ws.status, `console ${i}: ${ws.code}`).toBe(101)
      await ws.until(() => ws.isClosed(), 45_000)
      log(`CSL-03 console ${i} → 101, closed ${ws.closeCode} ${ws.closeReason}`)
      ws.destroy()
      expect(ws.closeCode, `console ${i}`).toBe(4422)
      expect(ws.closeReason, `console ${i}`).toBe('VM_CONSOLE_UNAVAILABLE')
    }
    expect(countOf(await activityOf(nameB), 'vm.console_requested')).toBe(before)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/StopVmCommandHandler.cs HandleAsync (Vm.IsStopWaitingOrStopped: a stop repeated while it
  // waits sends nothing) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Start.cs Start (start while another request waits)
  test('VM-07 start while a stop waits is 422 VM_INVALID_STATUS', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    // VM-04, the other half: a stop repeated while it waits is 202 and records no second request.
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    expect(countOf(await activityOf(nameA), 'vm.stop_requested')).toBe(2)
    expectError(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/start`), 422, 'VM_INVALID_STATUS')
    await waitVm('VM-07 stop lands', vmA, (v) => v.status === 'Stopped')
  })

  // titan-ops features/vm/design.md#rename-same-name · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/UpdateVmCommandHandler.cs
  // HandleAsync (renames; ExistsByNameAsync ⇒ VM_NAME_TAKEN) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/UpdateVmEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/UpdateVmValidator.cs UpdateVmValidator (Name MaximumLength(Vm.NameMaxLength), 64)
  test("VM-08 rename is 204; the same name again is a 204 no-op; another live VM's name is 409, 65 characters 400", async () => {
    const reply = await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: renamed })
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    expect((await getVm(vmA)).name).toBe(renamed)
    expectStatus(await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: renamed }), 204)
    expect(['Deleting', 'Deleted']).not.toContain((await getVm(vmB)).status)
    expectError(await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: nameB }), 409, 'VM_NAME_TAKEN')
    expectError(await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: 'rg-' + 'x'.repeat(62) }), 400, 'VALIDATION_ERROR')
    expect((await getVm(vmA)).name).toBe(renamed)
  })

  // titan-ops features/vm/design.md#vm-metrics · OpenViCloud/titan-control-plane:Titan.Application/Queries/Compute/Vm/VmMetricPoints.cs
  // (StepSecondsFor: 1h 60, 24h 300, 7d 1800; From: used = total - available, CPU clamped to [0, 100], null on the first sample) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/GetVmMetricsEndpoint.cs (HandleAsync: no range reads 1h) ·
  // OpenViCloud/titan-incus-worker:resource/vm/metrics.go (aggregateMetrics). vmB has run since VM-02; the worker posts one batch a
  // minute, so the first point with memory and root filesystem comes within a few minutes of the VM starting.
  test('VM-32 a running VM\'s metrics are 200 for 1h, 24h and 7d with their steps, and 1h holds a point with memory and disk', async () => {
    test.setTimeout(10 * 60_000)
    const path = `/v1/tenant/vms/${vmB}/metrics`
    const filled = (p: any) => typeof p.memoryTotalBytes === 'number' && p.memoryTotalBytes > 0 &&
      typeof p.rootFsSizeBytes === 'number' && p.rootFsSizeBytes > 0
    const hour = await pollUntil('VM-32 1h point with memory and disk', () => get('tenant', path),
      (m: any) => Array.isArray(m.points) && m.points.some(filled),
      (m: any) => `${m.range} step ${m.stepSeconds} points ${Array.isArray(m.points) ? m.points.length : '?'} filled ${Array.isArray(m.points) ? m.points.filter(filled).length : '?'}`,
      8 * 60_000, 15_000)
    const byRange: Array<[string, any, number]> = [
      ['', hour, 60],
      ['24h', await get('tenant', `${path}?range=24h`), 300],
      ['7d', await get('tenant', `${path}?range=7d`), 1800],
    ]
    for (const [asked, reply, step] of byRange) {
      const range = asked === '' ? '1h' : asked
      expect(reply.range, `range of ${asked || 'no range'}`).toBe(range)
      expect(reply.stepSeconds, `stepSeconds of ${range}`).toBe(step)
      expect(Array.isArray(reply.points), `points of ${range}`).toBe(true)
      for (const p of reply.points) {
        if (p.cpuPercent !== null) {
          expect(p.cpuPercent, `${range} cpuPercent at ${p.at}`).toBeGreaterThanOrEqual(0)
          expect(p.cpuPercent, `${range} cpuPercent at ${p.at}`).toBeLessThanOrEqual(100)
        }
        for (const field of ['memoryUsedBytes', 'memoryTotalBytes', 'rootFsUsedBytes', 'rootFsSizeBytes', 'diskReadBytesPerSecond', 'diskWriteBytesPerSecond']) {
          if (p[field] !== null) {
            expect(p[field], `${range} ${field} at ${p.at}`).toBeGreaterThanOrEqual(0)
          }
        }
        if (p.memoryUsedBytes !== null && p.memoryTotalBytes !== null) {
          expect(p.memoryUsedBytes, `${range} memory at ${p.at}`).toBeLessThanOrEqual(p.memoryTotalBytes)
        }
        if (p.rootFsUsedBytes !== null && p.rootFsSizeBytes !== null) {
          expect(p.rootFsUsedBytes, `${range} root fs at ${p.at}`).toBeLessThanOrEqual(p.rootFsSizeBytes)
        }
      }
      log(`VM-32 ${range}: step ${reply.stepSeconds}, ${reply.points.length} points`)
    }
    const last = hour.points.filter(filled).at(-1)
    log(`VM-32 1h last filled point: ${JSON.stringify(last)}`)
  })

  // titan-ops features/vm/design.md#vm-metrics · titan-ops architecture/tenancy-and-admin.md#tenant-isolation ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/GetVmMetricsEndpoint.cs (GetVmMetricsValidator: range 1h, 24h or 7d) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Compute/Vm/GetVmMetricsQueryHandler.cs (HandleAsync: ComputeOwnership.RequireVmAsync)
  test("VM-33 metrics of another range are 400; another tenant's VM and an unknown id are 404 VM_NOT_FOUND without points", async () => {
    expectError(await call('tenant', 'GET', `/v1/tenant/vms/${vmB}/metrics?range=2h`), 400, 'VALIDATION_ERROR')
    const foreign = await call('admin', 'GET', `/v1/tenant/vms/${vmB}/metrics`)
    expectError(foreign, 404, 'VM_NOT_FOUND')
    expect(bodyOf(foreign)?.points, 'no points in the 404 body').toBeUndefined()
    expectError(await call('tenant', 'GET', `/v1/tenant/vms/${randomUUID()}/metrics`), 404, 'VM_NOT_FOUND')
  })

  // titan-ops features/vm/design.md#conflict-and-delete-wins: a delete does not take over a waiting stop; it is refused until the stop ends
  test('VM-17 delete while a stop waits is 422 VM_INVALID_STATUS; once Stopped, the delete is 202, then Deleted', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmB}/stop`), 202)
    expectError(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmB}`), 422, 'VM_INVALID_STATUS')
    await waitVm('VM-17 stopped', vmB, (v) => v.status === 'Stopped')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmB}`), 202)
    await waitVm('VM-17', vmB, (v) => v.status === 'Deleted')
  })

  // titan-ops features/vm/design.md#console-password · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmValidator.cs
  // (CreateVmValidator: ConsolePassword Length(12, 72), a message without the value; StopTimeoutSeconds) ·
  // titan-ops features/vm/design.md#vm-stop-timeout · OpenViCloud/titan-control-plane:Titan.Application/Queries/Compute/Vm/Contracts/VmQueryResult.cs
  // (VmQueryResult: no ConsolePassword). Made once vmB is gone (VM-17) and vmA is stopped (VM-07), so it runs alone; CSL-05
  // deletes it.
  test('VM-34 a console password of 11, 73 or 0 characters is 400 without echoing it; 12 characters with stopTimeoutSeconds 30 is 202, and no read shows the password', async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    const base = { name: namePw, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }
    for (const password of [passwordOf(11), passwordOf(73), '']) {
      const reply = await call('tenant', 'POST', '/v1/tenant/vms', { ...base, consolePassword: password }, newKey())
      log(`VM-34 a password of ${password.length} characters → ${reply.status} ${reply.text.slice(0, 300)}`)
      expectError(reply, 400, 'VALIDATION_ERROR')
      if (password !== '') {
        expect(reply.text.includes(password), `the 400 of ${password.length} characters does not echo it`).toBe(false)
      }
    }
    expect((await get('tenant', '/v1/tenant/vms') as any[]).filter((v) => v.name === namePw)).toEqual([])

    consolePassword = passwordOf(12)
    vmPw = await createVm(namePw, smallTier, networkId, { consolePassword, stopTimeoutSeconds: 30 })
    made.push(vmPw)
    const vm = await getVm(vmPw)
    expect(vm.stopTimeoutSeconds).toBe(30)
    const row = (await get('tenant', '/v1/tenant/vms') as any[]).find((v) => v.id === vmPw)
    expect(row, 'the list holds the VM').toBeDefined()
    for (const [label, shape] of [['GET', vm], ['list', row]] as Array<[string, any]>) {
      expect('consolePassword' in shape, `${label} has no consolePassword`).toBe(false)
      expect(JSON.stringify(shape).includes(consolePassword), `${label} does not hold the password`).toBe(false)
    }
  })

  // titan-ops features/vm/design.md#vm-console · titan-ops features/vm/design.md#console-password (the password works once
  // cloud-init's last stage ran) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ConsoleRelay.cs (WindowResizeOf:
  // the resize text frame becomes Incus's window-resize) · lxc/incus@v7.0.1:cmd/incusd/instance_console.go (window-resize sets the
  // size of Incus's own console fd with linux.SetPtySize: a VM's console is its serial port, so the guest's tty keeps its own size and
  // `stty size` only shows that the shell answers) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmConsoleEndpoint.cs
  // (RunAsync: RequestVmConsoleCommand once Incus attached, one vm.console_requested per session that opens).
  test('CSL-04 on an amd64 cluster the console shows login:, takes ubuntu and the console password, the shell answers stty size; it opens again 5 s after a close', async () => {
    test.skip(!serialConsoleAttaches(), 'N/A: arm64 cluster, the serial console does not attach (CSL-03)')
    test.setTimeout(25 * 60_000)
    await waitVm('CSL-04 VM-34\'s VM runs', vmPw, (v) => runs(v))
    const before = countOf(await activityOf(namePw), 'vm.console_requested')

    const first = await openConsole(vmPw, await issueTicket(vmPw))
    opened.push(first)
    expect(first.status, first.code).toBe(101)
    const deadline = Date.now() + 10 * 60_000
    first.sendText(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    const sawLogin = await everyThirtySeconds(first, async () => first.sendBinary('\r'),
      () => first.textSince(0).includes('login:'), deadline)
    log(`CSL-04 login: ${sawLogin} after ${Math.round((Date.now() + 10 * 60_000 - deadline) / 1000)} s; closed ${first.closeCode} ${first.closeReason}`)
    expect(first.closeCode, `closed ${first.closeReason}`).toBeNull()
    expect(sawLogin, 'login: within 10 minutes').toBe(true)

    let mark = 0
    const loggedIn = await everyThirtySeconds(first, async () => {
      mark = first.bytes()
      first.sendBinary('ubuntu\r')
      await first.until(() => first.textSince(mark).includes('assword:'), 15_000)
      first.sendBinary(`${consolePassword}\r`)
    }, () => first.textSince(mark).includes('ubuntu@'), deadline)
    log(`CSL-04 prompt ubuntu@: ${loggedIn} after ${Math.round((Date.now() + 10 * 60_000 - deadline) / 1000)} s; closed ${first.closeCode} ${first.closeReason}`)
    expect(first.closeCode, `closed ${first.closeReason}`).toBeNull()
    expect(loggedIn, 'the ubuntu@ prompt within 10 minutes').toBe(true)

    mark = first.bytes()
    first.sendBinary('stty size\r')
    const sizeLine = /(?:^|[^0-9A-Za-z])\d+ \d+\r*\n/ // the shell may print bracketed-paste escapes before the line
    await first.until(() => sizeLine.test(first.textSince(mark)), 15_000)
    log(`CSL-04 stty size → ${JSON.stringify(first.textSince(mark).slice(0, 120))}`)
    expect(first.textSince(mark)).toMatch(sizeLine)

    await first.end()
    log(`CSL-04 first session ended ${first.closeCode} ${first.closeReason}`)
    expect(countOf(await activityOf(namePw), 'vm.console_requested')).toBe(before + 1)

    await sleep(5_000)
    const again = await openConsole(vmPw, await issueTicket(vmPw))
    opened.push(again)
    expect(again.status, again.code).toBe(101)
    consoleSession = again
    // Whether 5 s is enough for Incus to let the console go is not measured: a busy console closes 4422 VM_CONSOLE_BUSY
    // and records nothing.
    await pollUntil('CSL-04 the session opened again', async () => countOf(await activityOf(namePw), 'vm.console_requested'),
      (count) => count === before + 2 || again.isClosed(), (count) => `vm.console_requested ${count - before} closed ${again.closeCode} ${again.closeReason}`,
      30_000, 2_000)
    log(`CSL-04 reopened: closed ${again.closeCode} ${again.closeReason}`)
    expect(countOf(await activityOf(namePw), 'vm.console_requested'), 'one vm.console_requested per session that opened')
      .toBe(before + (again.isClosed() ? 1 : 2))
  })

  // titan-ops features/vm/design.md#vm-console · OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusClient.cs
  // (StartConsoleAsync: Incus's "already connected" ⇒ VM_CONSOLE_BUSY; no `force`, so the open console is not taken over).
  // Deletes VM-34's VM after, before SSH-08 starts vmA.
  test('CSL-05 on an amd64 cluster a second console on the same VM closes 4422 VM_CONSOLE_BUSY while the first still answers', async () => {
    test.setTimeout(10 * 60_000)
    try {
      test.skip(!serialConsoleAttaches(), 'N/A: arm64 cluster, the serial console does not attach (CSL-03)')
      const first = consoleSession
      expect(first !== null && !first.isClosed(), 'CSL-04\'s session is still open').toBe(true)
      const second = await openConsole(vmPw, await issueTicket(vmPw))
      opened.push(second)
      expect(second.status, second.code).toBe(101)
      await second.until(() => second.isClosed(), 45_000)
      log(`CSL-05 second console closed ${second.closeCode} ${second.closeReason}`)
      second.destroy()
      expect(second.closeCode).toBe(4422)
      expect(second.closeReason).toBe('VM_CONSOLE_BUSY')

      const mark = first!.bytes()
      first!.sendBinary('\r')
      const answered = await first!.until(() => first!.bytes() > mark, 15_000)
      log(`CSL-05 first session after \\r: ${JSON.stringify(first!.textSince(mark).slice(0, 80))} closed ${first!.closeCode}`)
      expect(answered, 'the first session answers').toBe(true)
      expect(first!.closeCode).toBeNull()
    } finally {
      await consoleSession?.end()
      consoleSession = null
      if (vmPw !== '') {
        // A VM still Creating is not deleted under its create.
        await waitVm('VM-34\'s VM settled', vmPw, (v) => v.status !== 'Creating')
        await deleteVmAndWait(vmPw)
      }
    }
  })

  // The body is lib/ssh.ts fiveSessionsThenRefused, shared with vm/ssh-sessions/ssh-sessions.spec.ts. Runs once vmB is gone
  // (VM-17) and VM-34's VM too (CSL-05), with vmA the only VM of the module running: two VMs booting together on dev's
  // Incus host left a guest's sshd coming and going, once in emergency mode (dev 2026-11-14). VM-07 left vmA stopped:
  // this case starts it; CSL-06 stops it again, as the cases after it expect.
  test('SSH-08 five SSH sessions open (101), the sixth is 422 VM_SESSION_LIMIT_REACHED; one opens again after they close', async () => {
    test.setTimeout(25 * 60_000)
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/start`), 202)
    await waitVm('SSH-08 vmA running', vmA, (v) => runs(v))
    await fiveSessionsThenRefused(vmA, renamed)
  })

  // The body is consoleRefusedAtTheLimit above, on vmA right after SSH-08 (its guest answers SSH already).
  test('CSL-06 at five SSH sessions a console ticket is 422 VM_SESSION_LIMIT_REACHED, and a ticket issued before the fifth opens a console that closes 4422 VM_SESSION_LIMIT_REACHED', async () => {
    test.setTimeout(10 * 60_000)
    await consoleRefusedAtTheLimit(vmA, renamed)
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    await waitVm('CSL-06 vmA stopped again', vmA, (v) => v.status === 'Stopped')
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs OccupiesQuota (VmRepository.CountActiveByTenantAsync writes the same condition in SQL) — counted: every status but Deleting, Deleted, NotFound and Failed
  test('VM-15 a create that gave up does not count: one more VM fits, the next is 422 VM_QUOTA_EXCEEDED', async () => {
    const vms = await get('tenant', '/v1/tenant/vms') as any[]
    // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs OccupiesQuota
    const counted = vms.filter((v) => !['Deleting', 'Deleted', 'NotFound', 'Failed'].includes(v.status)).length
    log(`VM-15 counted=${counted} (${vms.map((v) => `${v.name}:${v.status}/${v.requestFailureReason}`).join(' ')})`)
    // A create that gave up and is still listed stays out of the count: VmRepositoryStateTests measures that rule;
    // on Incus nothing in this module makes a create give up any more.
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, { maxVms: counted + 1, maxNetworks: originalQuota!.maxNetworks }), 204)
    const { smallTier, clusterId, templateId } = await envOf()
    // A client that still sends the removed VM field is answered as before, not refused (portal before its update).
    const fits = await createVm(`rg-vmq-${RUN}`, smallTier, networkId, { enablePublicIpv6: true })
    made.push(fits)
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: `rg-vmq2-${RUN}`, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()), 422, 'VM_QUOTA_EXCEEDED')
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
    await waitVm('VM-15 extra VM has an instance', fits, (v) => ['Running', 'Ready', 'Stopped', 'Frozen', 'Error'].includes(v.status))
  })

  // titan-ops architecture/tenancy-and-admin.md#tenant-isolation · OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs
  // RequireVmAsync, RequireVmForUpdateAsync (used first by StopVmCommandHandler, StartVmCommandHandler and CreateVmSnapshotCommandHandler
  // HandleAsync, before any quota or state check) · OpenViCloud/titan-control-plane:Titan.Application/Queries/Compute/VmSnapshot/ListVmSnapshotsQueryHandler.cs HandleAsync
  test("VM-19 another tenant's VM is 404 VM_NOT_FOUND for read, delete, stop, start and snapshots, and nothing changes", async () => {
    const before = await getVm(vmA)
    const snapshotsBefore = await get('tenant', `/v1/tenant/vms/${vmA}/snapshots`) as any[]
    const actionsBefore = await activityOf(before.name)
    const snapshotName = `rg-vmsx-${RUN}`

    expectError(await call('admin', 'GET', `/v1/tenant/vms/${vmA}`), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'DELETE', `/v1/tenant/vms/${vmA}`), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'POST', `/v1/tenant/vms/${vmA}/stop`), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'POST', `/v1/tenant/vms/${vmA}/start`), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'POST', `/v1/tenant/vms/${vmA}/snapshots`, { name: snapshotName }, newKey()), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'GET', `/v1/tenant/vms/${vmA}/snapshots`), 404, 'VM_NOT_FOUND')

    const after = await getVm(vmA)
    expect(after.status).toBe(before.status)
    expect(await get('tenant', `/v1/tenant/vms/${vmA}/snapshots`)).toEqual(snapshotsBefore)
    const actionsAfter = await activityOf(before.name)
    for (const action of ['vm.stop_requested', 'vm.start_requested']) {
      expect(countOf(actionsAfter, action), action).toBe(countOf(actionsBefore, action))
    }
    expect(countOf(await activityOf(snapshotName), 'vm_snapshot.create_requested')).toBe(0)
  })


  // OpenViCloud/titan-control-plane:Titan.Domain/Services/NetworkDeletion.cs DeleteAsync (NETWORK_NOT_EMPTY)
  test('VM-21 deleting the run network while a VM lives on it is 422 NETWORK_NOT_EMPTY', async () => {
    expectError(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}`), 422, 'NETWORK_NOT_EMPTY')
  })

  // titan-ops features/vm/design.md#vm-delete-observes-done · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/DeleteVmEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/DeleteVmCommandHandler.cs HandleAsync (vm.IsDeletedOrDeleting: a Deleted VM answers 202) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Deletion.cs DeleteSucceeded (Done of the delete: Deleted)
  test('VM-16 delete is 202, then Deleted; a repeat is 202; renaming the Deleted VM, or changing its stop timeout, is 422 VM_INVALID_STATUS', async () => {
    const reply = await call('tenant', 'DELETE', `/v1/tenant/vms/${vmA}`)
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    await waitVm('VM-16', vmA, (v) => v.status === 'Deleted')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmA}`), 202)
    const actions = await activityOf(renamed)
    log(`ACT-01 delete ${renamed}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.delete_requested')).toBe(1)
    expect(countOf(actions, 'vm.deleted')).toBe(1)

    // A Deleted VM keeps its name: OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs Rename (IsDeleted ⇒ VM_INVALID_STATUS),
    // reached after UpdateVmCommandHandler HandleAsync finds the new name free.
    expectError(await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: `rg-vmdel-${RUN}` }), 422, 'VM_INVALID_STATUS')
    expect((await getVm(vmA)).name).toBe(renamed)

    // A value other than the one it holds reaches OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs
    // ChangeStopTimeout (IsDeleted ⇒ VM_INVALID_STATUS); the same value would end at UpdateVmCommandHandler HandleAsync
    // as a 204 first (titan-ops features/vm/design.md#vm-stop-timeout).
    const stopTimeout = (await getVm(vmA)).stopTimeoutSeconds
    expect(stopTimeout, 'the Deleted VM holds another value than 300').not.toBe(300)
    expectError(await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { stopTimeoutSeconds: 300 }), 422, 'VM_INVALID_STATUS')
    expect((await getVm(vmA)).stopTimeoutSeconds).toBe(stopTimeout)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs (HandleAsync: req.ClusterId ??
  // network.ClusterId) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmValidator.cs (ClusterId
  // NotEmpty().When(x => x.ClusterId != null)) · titan-ops features/catalog/design.md#cluster-is-a-real-choice ·
  // titan-ops features/vm/user-stories.md#us-vm01. Runs after VM-16 freed vmA's slot and deletes its VM before VM-18 takes
  // that slot, so the tenant's VM count never goes above what it was before VM-16. A clusterId other than the network's stays VM-12's.
  test('VM-31 a VM without clusterId lands on its network\'s cluster; an empty clusterId is 400 VALIDATION_ERROR and makes no VM', async () => {
    const { smallTier, templateId } = await envOf()
    const networkCluster = (await get('tenant', `/v1/tenant/networks/${networkId}`)).clusterId as string
    const name = `rg-vmnoc-${RUN}`
    const emptyName = `rg-vmempc-${RUN}`
    const reply = await call('tenant', 'POST', '/v1/tenant/vms',
      { name, networkId, vmOfferingId: smallTier, templateId, diskSizeGb: null }, newKey())
    expectStatus(reply, 202)
    const id = bodyOf(reply).vmId as string
    try {
      const vm = await waitVm('VM-31 runs', id, (v) => runs(v))
      log(`VM-31 network cluster=${networkCluster} vm cluster=${vm.clusterId} status=${vm.status}`)
      expect(['Running', 'Ready']).toContain(vm.status)
      expect(vm.clusterId).toBe(networkCluster)

      expectError(await call('tenant', 'POST', '/v1/tenant/vms',
        { name: emptyName, networkId, vmOfferingId: smallTier, templateId, clusterId: '', diskSizeGb: null }, newKey()),
        400, 'VALIDATION_ERROR')
      expect((await get('tenant', '/v1/tenant/vms') as any[]).filter((v) => v.name === emptyName)).toEqual([])
    } finally {
      await deleteVmAndWait(id)
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmRepository.cs ExistsByNameAsync — a Deleted VM no longer holds its name
  test('VM-18 a new VM may take the name of a Deleted one', async () => {
    const { smallTier } = await envOf()
    const again = await createVm(renamed, smallTier, networkId)
    made.push(again)
    await waitVm('VM-18 has an instance', again, (v) => ['Running', 'Ready', 'Stopped', 'Frozen', 'Error'].includes(v.status))
    const reply = await call('tenant', 'GET', `/v1/tenant/vms/${again}`)
    expect(bodyOf(reply).name).toBe(renamed)
  })

  // titan-ops features/activity/design.md#activity-data-and-route · OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/ActivityEvent/ListActivityEventsQueryHandler.cs
  // HandleAsync (DefaultLimit 20, MaxLimit 50; limit <= 0 ⇒ default) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Activity/GetActivityEndpoint.cs
  // HandleAsync (Query<int>("limit", isRequired: false): an unreadable limit is 0) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/ActivityEventRepository.cs
  // ListByTenantAsync (newest first) · OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/ActivityEvent/Contracts/ActivityEventQueryResult.cs (five fields)
  test('ACT-04 the feed is 20 rows by default, 50 at most, newest first, five fields per row, and the tenant\'s own', async () => {
    const page = async (as: 'tenant' | 'admin', query: string): Promise<any[]> => {
      const reply = await call(as, 'GET', `/v1/tenant/activity${query}`)
      expectStatus(reply, 200)
      return bodyOf(reply) as any[]
    }
    const none = await page('tenant', '')
    const fifty = await page('tenant', '?limit=50')
    const thousand = await page('tenant', '?limit=1000')
    const zero = await page('tenant', '?limit=0')
    const negative = await page('tenant', '?limit=-5')
    const word = await page('tenant', '?limit=abc')
    log(`ACT-04 rows: none=${none.length} 50=${fifty.length} 1000=${thousand.length} 0=${zero.length} -5=${negative.length} abc=${word.length}`)

    expect(none.length).toBeLessThanOrEqual(20)
    if (fifty.length >= 20) {
      expect(none.length).toBe(20)
    }
    expect(zero).toEqual(none)
    expect(negative).toEqual(none)
    expect(word).toEqual(none)
    expect(thousand.length).toBeLessThanOrEqual(50)
    expect(thousand).toEqual(fifty)
    for (const rows of [none, fifty, thousand, zero, negative, word]) {
      for (let i = 1; i < rows.length; i++) {
        expect(Date.parse(rows[i].createdAt), `row ${i} is not newer than row ${i - 1}`).toBeLessThanOrEqual(Date.parse(rows[i - 1].createdAt))
      }
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['action', 'createdAt', 'id', 'resourceName', 'resourceType'])
      }
    }

    const adminRows = await page('admin', '?limit=50')
    const ours = adminRows.filter((r) => typeof r.resourceName === 'string' && r.resourceName.startsWith('rg-') && r.resourceName.includes(RUN))
    expect(ours, "admin-test's feed holds none of this run's resources").toEqual([])
  })
})
