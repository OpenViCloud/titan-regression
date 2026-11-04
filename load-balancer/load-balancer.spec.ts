import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { cleanUp } from './clean-up'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, existenceShape, runNetwork, waitNetwork, networkUsable, waitVm } from './fixtures'

// Cases LB-01..LB-07, LB-09..LB-11 and LB-13..LB-15 of plan.md (LB-08, traffic through the VIP, and LB-12 read the Incus
// host). The run network has no public IPv6 and beta-user holds one network, so the positive cases raise maxNetworks by
// one for a second network with IPv6, and give it back in afterAll — in a cluster that names no IPv6 block they are
// skipped. LB-09, LB-10, LB-11, LB-13, LB-14 and LB-15 run between LB-05 and LB-06 on load balancers of their own, never
// LB-03's (LB-06 counts activity by its name), each Deleted before LB-06/LB-07.
test.describe.serial('load-balancer', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  const lbName = `rg-lb-${RUN}`
  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null
  // LB-15 lowers maxLoadBalancers: the value read before, given back at once and again in afterAll.
  let originalMaxLoadBalancers: number | null = null
  let runNetworkId = ''
  let ipv6NetworkId = ''
  let subnet = ''
  let vmId = ''
  let lbId = ''
  // LB-09, LB-10, LB-11, LB-13: load balancers of their own on the same network, Deleted before LB-06; afterAll deletes
  // any a broken run left, or the IPv6 network cannot go.
  const extraLbIds: string[] = []
  // LB-14: a VM on the run network, deleted in its finally.
  let otherVmId = ''

  const http = { protocol: 'TCP', port: 80, targetPort: 8080 }
  const dns = { protocol: 'UDP', port: 53, targetPort: 53 }

  const readLb = (id: string) => get('tenant', `/v1/tenant/load-balancers/${id}`)

  const atRest = (id: string, label: string) =>
    pollUntil(label, () => readLb(id), (row) => row.currentExistence === 'Exists' && row.transition === null, existenceShape)

  const deleted = (id: string, label: string) =>
    pollUntil(label, () => readLb(id), (row) => row.currentExistence === 'Deleted', existenceShape)

  // The activity rows of one name, oldest first (the feed answers newest first).
  async function timelineOf(name: string): Promise<string[]> {
    return (await activityOf(name)).reverse()
  }

  async function createExtraLb(name: string): Promise<string> {
    const created = await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name, networkId: ipv6NetworkId, listeners: [http], backends: [{ vmId }] }, newKey())
    expectStatus(created, 202)
    const id = bodyOf(created).loadBalancerId as string
    extraLbIds.push(id)
    return id
  }

  async function deleteLbAndWait(id: string, label: string): Promise<void> {
    const lb = await readLb(id)
    if (lb.desiredExistence === 'Exists') {
      await pollUntil(`${label} at rest`, () => readLb(id), (row) => row.transition === null, existenceShape)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${id}`), 202)
    }
    await deleted(id, `${label} deleted`)
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('load-balancer')
    useBrowser(browser)
    runNetworkId = (await runNetwork()).id
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    originalQuota = { maxVms: tenant.maxVms, maxNetworks: tenant.maxNetworks }
    log(`quota before: ${JSON.stringify(originalQuota)}`)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    const extraSteps = extraLbIds.map((id): [string, () => Promise<void>] =>
      [`load balancer ${id}`, () => deleteLbAndWait(id, `load balancer ${id}`)])
    await cleanUp([
      ...extraSteps,
      ['load balancer', async () => {
        if (lbId !== '') {
          await deleteLbAndWait(lbId, 'load balancer')
        }
      }],
      ['vm on the run network', async () => {
        if (otherVmId !== '') {
          await deleteVmAndWait(otherVmId)
        }
      }],
      ['vm', async () => {
        if (vmId !== '') {
          await deleteVmAndWait(vmId)
        }
      }],
      ['IPv6 network', async () => {
        if (ipv6NetworkId === '') {
          return
        }
        const network = await get('tenant', `/v1/tenant/networks/${ipv6NetworkId}`)
        if (network.desiredExistence === 'Exists') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${ipv6NetworkId}`), 202)
        }
        await waitNetwork('IPv6 network deleted', ipv6NetworkId, (n) => n.currentExistence === 'Deleted')
      }],
      ['quota', async () => {
        if (originalQuota === null) {
          return
        }
        const body: Record<string, number> = { ...originalQuota }
        if (originalMaxLoadBalancers !== null) {
          body.maxLoadBalancers = originalMaxLoadBalancers
        }
        expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, body), 204)
      }],
      ['sessions', closeSessions],
    ])
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs ProviderIdForLoadBalancer — Incus refuses a load
  // balancer on a network with no uplink, and a network without public IPv6 has none
  test('LB-01 a load balancer on a network without public IPv6 is 422 LOAD_BALANCER_NEEDS_PUBLIC_IPV6', async () => {
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: runNetworkId, listeners: [http], backends: [{ vmId: '00000000-0000-0000-0000-000000000001' }] }, newKey()),
      422, 'LOAD_BALANCER_NEEDS_PUBLIC_IPV6')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/LoadBalancer/CreateLoadBalancerValidator.cs (CreateLoadBalancerValidator: Name
  // matches LoadBalancer.NamePattern, Listeners) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/LoadBalancer/LoadBalancerSpecRules.cs
  // (LoadBalancerSpecRules) · titan-ops features/load-balancer/design.md#lb-resource-model
  test('LB-02 no listener, the same protocol and port twice, or a name starting with a hyphen is 400 VALIDATION_ERROR', async () => {
    const backends = [{ vmId: '00000000-0000-0000-0000-000000000001' }]
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: runNetworkId, listeners: [], backends }, newKey()), 400, 'VALIDATION_ERROR')
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: runNetworkId, listeners: [http, { ...http, targetPort: 9090 }], backends }, newKey()), 400, 'VALIDATION_ERROR')
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: `-lb-${RUN}`, networkId: runNetworkId, listeners: [http], backends }, newKey()), 400, 'VALIDATION_ERROR')
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/LoadBalancer/ValueObjects/LoadBalancerVip.cs (LoadBalancerVip) — interface id 0:0:1:n of
  // the /64 · titan-ops features/load-balancer/design.md#vip-in-network-64 ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs (RequireLoadBalancerAsync, RequireLoadBalancerForUpdateAsync) —
  // another tenant's load balancer is 404 LOAD_BALANCER_NOT_FOUND on GET, PATCH and DELETE, and stays as it was
  test("LB-03 on an IPv6 network with a VM: 202, then Exists, VIP <64>::1:1, the VM as backend; another tenant's GET, PATCH, DELETE are 404", async () => {
    const { clusterId, smallTier } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    const block = clusters.find((c) => c.clusterId === clusterId)?.providerSettings?.ipv6Block ?? null
    log(`LB-03 cluster=${clusterId} ipv6Block=${block}`)
    test.skip(!block, 'the cluster has no IPv6 block')

    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`,
      { maxVms: originalQuota!.maxVms, maxNetworks: originalQuota!.maxNetworks + 1 }), 204)
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net6-${RUN}`, clusterId, enablePublicIpv6: true }, newKey())
    expectStatus(reply, 202)
    ipv6NetworkId = bodyOf(reply).networkId
    const network = await waitNetwork('IPv6 network usable', ipv6NetworkId, networkUsable)
    subnet = network.publicIpv6Subnet
    expect(subnet).toMatch(/\/64$/)
    vmId = await createVm(`rg-vmlb-${RUN}`, smallTier, ipv6NetworkId)
    await waitVm('backend VM on Incus', vmId, (v) => v.currentExistence === 'Exists')

    const created = await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: ipv6NetworkId, listeners: [http], backends: [{ vmId }] }, newKey())
    expectStatus(created, 202)
    lbId = bodyOf(created).loadBalancerId
    const lb = await atRest(lbId, 'load balancer on Incus')
    const prefix = subnet.replace(/::\/64$/, '')
    log(`LB-03 vip=${lb.vip} subnet=${subnet}`)
    expect(lb.vip).toBe(`${prefix}::1:1`)
    expect(lb.listeners).toEqual([http])
    expect(lb.backends).toEqual([{ vmId }])

    expectError(await call('admin', 'GET', `/v1/tenant/load-balancers/${lbId}`), 404, 'LOAD_BALANCER_NOT_FOUND')
    expectError(await call('admin', 'PATCH', `/v1/tenant/load-balancers/${lbId}`, { name: `rg-lbx-${RUN}` }), 404, 'LOAD_BALANCER_NOT_FOUND')
    expectError(await call('admin', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 404, 'LOAD_BALANCER_NOT_FOUND')
    const own = await readLb(lbId)
    log(`LB-03 after admin-test: name=${own.name} ${existenceShape(own)}`)
    expect(own.name).toBe(lbName)
    expect(own.desiredExistence).toBe('Exists')
    expect(own.transition).toBeNull()
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/UpdateLoadBalancerCommandHandler.cs HandleAsync — the same
  // configuration is a repeat; another one is a new request the worker writes in one PUT
  test('LB-04 PUT of the same configuration changes nothing; PUT of a new one goes Updating, then rests on it', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    expectStatus(await call('tenant', 'PUT', `/v1/tenant/load-balancers/${lbId}`, { listeners: [http], backends: [{ vmId }] }), 204)
    expect((await readLb(lbId)).transition).toBeNull()

    expectStatus(await call('tenant', 'PUT', `/v1/tenant/load-balancers/${lbId}`, { listeners: [http, dns], backends: [{ vmId }] }), 204)
    const lb = await pollUntil('update done', () => readLb(lbId), (row) => row.transition === null, existenceShape)
    expect(lb.listeners).toEqual([http, dns])
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Services/VmDeletion.cs RequestAsync (VM_IS_LOAD_BALANCER_BACKEND) — refused, the load balancer is not
  // edited behind the customer's back
  test('LB-05 deleting a VM a load balancer sends to is 422 VM_IS_LOAD_BALANCER_BACKEND', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    expectError(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`), 422, 'VM_IS_LOAD_BALANCER_BACKEND')
    expect((await get('tenant', `/v1/tenant/vms/${vmId}`)).desiredExistence).toBe('Exists')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/LoadBalancer/RenameLoadBalancerEndpoint.cs (Patch, 204, no provider command);
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/RenameLoadBalancerCommandHandler.cs HandleAsync
  // (LOAD_BALANCER_NAME_TAKEN) · titan-ops features/load-balancer/design.md#lb-rename ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/LoadBalancer/ValueObjects/LoadBalancerVip.cs (FirstFree: the lowest number no live load
  // balancer of the network holds; LB-03's holds 1) · titan-ops features/load-balancer/design.md#vip-in-network-64
  test('LB-09 a second load balancer gets VIP <64>::1:2; rename is 204 and keeps it; a name another load balancer holds is 409 LOAD_BALANCER_NAME_TAKEN', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const secondLbId = await createExtraLb(`rg-lb2-${RUN}`)
    const before = await atRest(secondLbId, 'second load balancer on Incus')
    expect(before.vip).toBe(`${subnet.replace(/::\/64$/, '')}::1:2`)
    const renamed = await call('tenant', 'PATCH', `/v1/tenant/load-balancers/${secondLbId}`, { name: `rg-lb2r-${RUN}` })
    expectStatus(renamed, 204)
    expect(renamed.text).toBe('')
    const after = await readLb(secondLbId)
    log(`LB-09 renamed ${before.name} → ${after.name}, vip ${before.vip} → ${after.vip}`)
    expect(after.name).toBe(`rg-lb2r-${RUN}`)
    expect(after.vip).toBe(before.vip)
    expectError(await call('tenant', 'PATCH', `/v1/tenant/load-balancers/${secondLbId}`, { name: lbName }), 409, 'LOAD_BALANCER_NAME_TAKEN')
    expect((await readLb(lbId)).name).toBe(lbName)
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${secondLbId}`), 202)
    await deleted(secondLbId, 'second load balancer deleted')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/UpdateLoadBalancerCommandHandler.cs (HandleAsync: HasDesiredSpec —
  // a repeat records nothing and sends nothing) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/LoadBalancer/LoadBalancer.cs (RequestUpdate:
  // RestsOnIncus — another configuration while one waits is LOAD_BALANCER_INVALID_STATE) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/DeleteLoadBalancerCommandHandler.cs (HandleAsync: IsDeletedOrDeleting)
  // · titan-ops architecture/resource-lifecycle.md#repeat · titan-ops architecture/resource-lifecycle.md#one-key-per-request
  test('LB-10 a repeated PUT joins the waiting update, another configuration meanwhile is 422; two DELETEs make one request', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const name = `rg-lbu-${RUN}`
    const id = await createExtraLb(name)
    await atRest(id, 'LB-10 load balancer on Incus')

    expectStatus(await call('tenant', 'PUT', `/v1/tenant/load-balancers/${id}`, { listeners: [http, dns], backends: [{ vmId }] }), 204)
    expectStatus(await call('tenant', 'PUT', `/v1/tenant/load-balancers/${id}`, { listeners: [http, dns], backends: [{ vmId }] }), 204)
    log(`LB-10 before the third PUT: ${existenceShape(await readLb(id))}`)
    const third = await call('tenant', 'PUT', `/v1/tenant/load-balancers/${id}`, { listeners: [dns], backends: [{ vmId }] })
    log(`LB-10 third PUT → ${third.status} ${third.text.slice(0, 200)}`)
    const rested = await pollUntil('LB-10 update at rest', () => readLb(id), (row) => row.transition === null, existenceShape)

    let timeline = await timelineOf(name)
    log(`LB-10 activity ${name} after the updates: ${timeline.join(', ')}`)
    if (third.status === 204) {
      // The first update rested before the third PUT, so the third was a new request: count only what came before it.
      const firstAsk = timeline.indexOf('load_balancer.update_requested')
      const secondAsk = timeline.indexOf('load_balancer.update_requested', firstAsk + 1)
      expect(secondAsk, 'a third PUT answered 204 is a second update_requested').toBeGreaterThan(-1)
      expect(timeline.slice(0, secondAsk), 'the first update ended before the third PUT').toContain('load_balancer.updated')
      const reason = 'the first update rested before the third PUT: its 422 is not measured on this lap'
      test.info().annotations.push({ type: 'skip', description: `LB-10 third PUT: ${reason}` })
      log(`LB-10 skip part: ${reason}`)
      timeline = timeline.slice(0, secondAsk)
    } else {
      expectError(third, 422, 'LOAD_BALANCER_INVALID_STATE')
      expect(rested.listeners).toEqual([http, dns])
    }
    expect(countOf(timeline, 'load_balancer.update_requested'), 'update_requested').toBe(1)
    expect(countOf(timeline, 'load_balancer.updated'), 'updated').toBe(1)

    const first = await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${id}`)
    const again = await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${id}`)
    expectStatus(first, 202)
    expectStatus(again, 202)
    await deleted(id, 'LB-10 load balancer deleted')
    const actions = await activityOf(name)
    log(`LB-10 activity ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'load_balancer.delete_requested'), 'delete_requested').toBe(1)
    expect(countOf(actions, 'load_balancer.deleted'), 'deleted').toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/LoadBalancer/LoadBalancer.cs (RequestDelete: a delete replaces a waiting update;
  // EndRequest: a report for a request no longer waiting ends nothing) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/EndLoadBalancerRequestCommandHandler.cs (HandleAsync: an ignored
  // report records no outcome) · titan-ops architecture/resource-lifecycle.md#repeat · titan-ops features/load-balancer/design.md#lb-lifecycle
  test('LB-11 a DELETE while an update waits replaces it: Deleting, then Deleted, and no load_balancer.updated', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const name = `rg-lbr-${RUN}`
    const id = await createExtraLb(name)
    await atRest(id, 'LB-11 load balancer on Incus')

    expectStatus(await call('tenant', 'PUT', `/v1/tenant/load-balancers/${id}`, { listeners: [http, dns], backends: [{ vmId }] }), 204)
    const reply = await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${id}`)
    expectStatus(reply, 202)
    const right = await readLb(id)
    log(`LB-11 right after DELETE: ${existenceShape(right)}`)
    // Already Deleted would mean the worker finished the delete between two calls: nothing to read then.
    if (right.currentExistence !== 'Deleted') {
      expect(right.transition).toBe('Deleting')
    }
    await deleted(id, 'LB-11 load balancer deleted')

    const timeline = await timelineOf(name)
    log(`LB-11 activity ${name}: ${timeline.join(', ')}`)
    const updatedAt = timeline.indexOf('load_balancer.updated')
    const updateRestedFirst = updatedAt > -1 && updatedAt < timeline.indexOf('load_balancer.delete_requested')
    test.skip(updateRestedFirst, 'the update rested before the DELETE: nothing was replaced on this lap')
    expect(countOf(timeline, 'load_balancer.update_requested'), 'update_requested').toBe(1)
    expect(countOf(timeline, 'load_balancer.delete_requested'), 'delete_requested').toBe(1)
    expect(countOf(timeline, 'load_balancer.deleted'), 'deleted').toBe(1)
    expect(countOf(timeline, 'load_balancer.updated'), 'updated').toBe(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/LoadBalancer/LoadBalancer.cs (RequestDelete: CreateIsWaiting ⇒ LOAD_BALANCER_INVALID_STATE)
  // · titan-ops features/load-balancer/design.md#lb-lifecycle
  test('LB-13 a DELETE while the create waits is 422 LOAD_BALANCER_INVALID_STATE; after Exists it is 202, then Deleted', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const id = await createExtraLb(`rg-lb3-${RUN}`)
    const before = await readLb(id)
    const early = await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${id}`)
    const after = await readLb(id)
    log(`LB-13 before: ${existenceShape(before)}; DELETE → ${early.status} ${early.text.slice(0, 200)}; after: ${existenceShape(after)}`)
    const raced = before.transition !== 'Creating' || after.transition !== 'Creating' || early.status === 202
    if (!raced) {
      expectError(early, 422, 'LOAD_BALANCER_INVALID_STATE')
    }
    if (early.status !== 202) {
      await atRest(id, 'LB-13 load balancer on Incus')
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${id}`), 202)
    }
    await deleted(id, 'LB-13 load balancer deleted')
    test.skip(raced, 'the create ended before the early DELETE was read: its 422 is not measured on this lap')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/LoadBalancer/LoadBalancerRequest.cs (BackendsAsync: a VM that does not exist is
  // LOAD_BALANCER_BACKEND_INVALID) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs (ProviderIdForLoadBalancerBackend: a VM on
  // another network is LOAD_BALANCER_BACKEND_INVALID) · titan-ops features/load-balancer/design.md#lb-resource-model
  test('LB-14 a backend that is no VM of the tenant, or a VM on another network, is 422 LOAD_BALANCER_BACKEND_INVALID', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const name = `rg-lbb-${RUN}`
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name, networkId: ipv6NetworkId, listeners: [http], backends: [{ vmId: randomUUID() }] }, newKey()),
      422, 'LOAD_BALANCER_BACKEND_INVALID')
    const { smallTier } = await envOf()
    try {
      otherVmId = await createVm(`rg-vmlbx-${RUN}`, smallTier, runNetworkId)
      await waitVm('LB-14 VM on the run network', otherVmId, (v) => v.currentExistence === 'Exists')
      expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
        { name, networkId: ipv6NetworkId, listeners: [http], backends: [{ vmId: otherVmId }] }, newKey()),
        422, 'LOAD_BALANCER_BACKEND_INVALID')
      const listed = await get('tenant', '/v1/tenant/load-balancers') as any[]
      expect(listed.filter((row) => row.name.startsWith('rg-lbb-')).map((row) => row.name)).toEqual([])
    } finally {
      if (otherVmId !== '') {
        await deleteVmAndWait(otherVmId)
        otherVmId = ''
      }
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/CreateLoadBalancerCommandHandler.cs (HandleAsync: TenantQuotaGate) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs (EnsureHasRoom: count >= cap ⇒
  // LOAD_BALANCER_QUOTA_EXCEEDED) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/LoadBalancer/LoadBalancer.cs (OccupiesQuota) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Platform/Tenant/UpdateTenantQuotaCommandHandler.cs (KeepOrReplace) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Tenant/Contracts/AdminTenantQueryResult.cs (MaxLoadBalancers) ·
  // titan-ops features/load-balancer/design.md#lb-quota-and-billing · titan-ops architecture/code-structure.md#quota-gate
  test('LB-15 with maxLoadBalancers 1 and one load balancer alive, a create is 422 LOAD_BALANCER_QUOTA_EXCEEDED', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const live = (await get('tenant', '/v1/tenant/load-balancers') as any[]).filter((row) => row.desiredExistence === 'Exists')
    log(`LB-15 live load balancers: ${live.map((row) => row.name).join(', ')}`)
    expect(live.map((row) => row.id)).toEqual([lbId])
    const row = (await get('admin', '/v1/tenants') as any[]).find((t) => t.id === tenantId)
    expect(row, `tenant ${tenantId} in GET /v1/tenants`).toBeDefined()
    originalMaxLoadBalancers = row.maxLoadBalancers as number
    log(`LB-15 quota now: maxVms=${row.maxVms} maxNetworks=${row.maxNetworks} maxLoadBalancers=${row.maxLoadBalancers}`)
    try {
      expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`,
        { maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxLoadBalancers: 1 }), 204)
      expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
        { name: `rg-lbq-${RUN}`, networkId: ipv6NetworkId, listeners: [http], backends: [{ vmId }] }, newKey()),
        422, 'LOAD_BALANCER_QUOTA_EXCEEDED')
    } finally {
      expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`,
        { maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxLoadBalancers: originalMaxLoadBalancers }), 204)
    }
    const listed = await get('tenant', '/v1/tenant/load-balancers') as any[]
    expect(listed.filter((lb) => lb.name.startsWith('rg-lbq-')).map((lb) => lb.name)).toEqual([])
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/DeleteLoadBalancerCommandHandler.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/LoadBalancer/LoadBalancer.cs (Rename: LOAD_BALANCER_INVALID_STATE once Deleted) ·
  // titan-ops features/activity/design.md#request-and-outcome-names · titan-ops features/load-balancer/design.md#lb-rename
  test('LB-06 delete is 202, then Deleted; a repeat is 202; one request and one outcome each; a rename after Deleted is 422', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const reply = await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`)
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    await deleted(lbId, 'load balancer deleted')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
    const listed = await get('tenant', '/v1/tenant/load-balancers') as any[]
    expect(listed.map((row) => row.id)).not.toContain(lbId)
    const actions = await activityOf(lbName)
    log(`LB-06 activity ${lbName}: ${actions.join(', ')}`)
    for (const action of ['create_requested', 'created', 'update_requested', 'updated', 'delete_requested', 'deleted']) {
      expect(countOf(actions, `load_balancer.${action}`), action).toBe(1)
    }
    expectError(await call('tenant', 'PATCH', `/v1/tenant/load-balancers/${lbId}`, { name: `rg-lbd-${RUN}` }), 422, 'LOAD_BALANCER_INVALID_STATE')
    expect((await readLb(lbId)).name).toBe(lbName)
  })

  test('LB-07 once the load balancer is Deleted, its VM deletes', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    await deleteVmAndWait(vmId)
    vmId = ''
  })
})
