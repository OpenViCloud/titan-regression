import { test, expect } from '@playwright/test'
import { randomBytes, randomUUID } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import type { Socket } from 'node:net'
import { closeSessions, headersOf, useBrowser } from './auth'
import { API, bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { startLocalProxyIfNeeded } from './local-proxy'
import { cleanUp } from './clean-up'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, waitVm } from './fixtures'

// Cases VM-01..19, VM-21, VM-22, VM-26, VM-27, VM-29, VM-31..33 and SSH-08 of plan.md, plus ACT-01/ACT-03/ACT-04 for VMs. VM-14 is
// NOT COVERED, VM-20 and VM-28 read the Incus host. Create checks run in this order
// (OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync): quota (TenantQuotaGate), cluster,
// name, network, offering, template — so the error cases run below the quota.
// A websocket upgrade over HTTP/1.1, as the CLI sends it (fetch cannot send Upgrade). An accepted one (101) hands back
// its socket, kept open until the caller destroys it; a refused one answers the usual JSON error.
type Upgrade = { status: number, code: string, socket: Socket | null }

async function upgrade(path: string): Promise<Upgrade> {
  await startLocalProxyIfNeeded(API)
  const headers = await headersOf('tenant')
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
      // The request's 30 s timeout must not end a session held open on purpose.
      socket.setTimeout(0)
      socket.removeAllListeners('timeout')
      socket.on('data', () => {})
      socket.on('error', () => {})
      resolve({ status: res.statusCode ?? 0, code: '', socket: socket as Socket })
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
        resolve({ status: res.statusCode ?? 0, code, socket: null })
      })
    })
    request.on('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('upgrade timed out')))
    request.end()
  })
}

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

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync (ExistsByNameAsync ⇒ VM_NAME_TAKEN)
  test('VM-10 a second VM with a live name is 409 VM_NAME_TAKEN', async () => {
    const { smallTier, clusterId, templateId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: nameA, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()), 409, 'VM_NAME_TAKEN')
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

  // titan-ops features/vm/design.md#ssh-session · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs
  // HandleAsync (limiter.TryAcquire before request.HandleAsync: a refusal records no vm.ssh_requested) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ShellSessionLimiter.cs MaxSessionsPerTenant (5, counted in the process:
  // right with one control plane replica, which this case assumes) · the guest's sshd ends an unauthenticated session after its
  // LoginGraceTime (120 s by default), so the sixth is opened while the five are surely still held.
  test('SSH-08 five SSH sessions open (101), the sixth is 422 VM_SESSION_LIMIT_REACHED; one opens again after they close', async () => {
    test.setTimeout(10 * 60_000)
    const path = `/v1/tenant/vms/${vmA}/ssh`
    // The guest agent may still be starting: probe until one upgrade is accepted, then let it end before counting.
    const started = Date.now()
    let probe = await upgrade(path)
    while (probe.status !== 101) {
      log(`SSH-08 probe → ${probe.status} ${probe.code}`)
      expect(Date.now() - started, 'the guest agent answers within 5 minutes').toBeLessThan(5 * 60_000)
      await sleep(10_000)
      probe = await upgrade(path)
    }
    probe.socket!.destroy()
    await sleep(15_000)

    const before = countOf(await activityOf(nameA), 'vm.ssh_requested')
    const held: Socket[] = []
    try {
      const firstOpened = Date.now()
      for (let i = 1; i <= 5; i++) {
        const reply = await upgrade(path)
        log(`SSH-08 session ${i} → ${reply.status} ${reply.code}`)
        if (reply.socket !== null) {
          held.push(reply.socket)
        }
        expect(reply.status, `session ${i}`).toBe(101)
      }
      const sixth = await upgrade(path)
      log(`SSH-08 session 6 → ${sixth.status} ${sixth.code} (+${Math.round((Date.now() - firstOpened) / 1000)}s)`)
      if (sixth.socket !== null) {
        held.push(sixth.socket)
      }
      expect(Date.now() - firstOpened, 'the sixth is opened within 2 minutes of the first').toBeLessThan(2 * 60_000)
      // Not part of the expectation; tells a 101 sixth caused by a session the server already ended from a limiter fault.
      log(`SSH-08 sessions still open on the client side: ${held.filter((s) => !s.destroyed).length}`)
      expect(sixth.status).toBe(422)
      expect(sixth.code).toBe('VM_SESSION_LIMIT_REACHED')
      expect(countOf(await activityOf(nameA), 'vm.ssh_requested') - before).toBe(5)
    } finally {
      for (const socket of held) {
        socket.destroy()
      }
    }
    await sleep(15_000)
    const again = await upgrade(path)
    log(`SSH-08 after closing → ${again.status} ${again.code}`)
    again.socket?.destroy()
    expect(again.status).toBe(101)
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

  // titan-ops features/vm/design.md#rename-same-name · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/RenameVmCommandHandler.cs
  // HandleAsync (alreadyNamedSo; ExistsByNameAsync ⇒ VM_NAME_TAKEN) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/UpdateVmEndpoint.cs HandleAsync ·
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
  test('VM-16 delete is 202, then Deleted; a repeat is 202; renaming the Deleted VM is 422 VM_INVALID_STATUS', async () => {
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
    // reached after RenameVmCommandHandler HandleAsync finds the new name free.
    expectError(await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: `rg-vmdel-${RUN}` }), 422, 'VM_INVALID_STATUS')
    expect((await getVm(vmA)).name).toBe(renamed)
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
