import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { cleanUp } from './clean-up'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, existenceShape, runNetwork, waitNetwork, networkUsable, waitVm } from './fixtures'

// Cases LB-01..LB-07 and LB-09 of plan.md (LB-08, traffic through the VIP, reads the Incus host). The run network has
// no public IPv6 and beta-user holds one network, so the positive cases raise maxNetworks by one for a second network
// with IPv6, and give it back in afterAll — in a cluster that names no IPv6 block they are skipped.
test.describe.serial('load-balancer', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  const lbName = `rg-lb-${RUN}`
  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null
  let runNetworkId = ''
  let ipv6NetworkId = ''
  let subnet = ''
  let vmId = ''
  let lbId = ''
  // LB-09: a second load balancer on the same network, renamed, deleted before LB-06.
  let secondLbId = ''

  const http = { protocol: 'TCP', port: 80, targetPort: 8080 }
  const dns = { protocol: 'UDP', port: 53, targetPort: 53 }

  const readLb = (id: string) => get('tenant', `/v1/tenant/load-balancers/${id}`)

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
    await cleanUp([
      ['second load balancer', async () => {
        if (secondLbId === '') {
          return
        }
        const lb = await readLb(secondLbId)
        if (lb.desiredExistence === 'Exists') {
          await pollUntil('second load balancer at rest', () => readLb(secondLbId), (row) => row.transition === null, existenceShape)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${secondLbId}`), 202)
        }
        await pollUntil('second load balancer deleted', () => readLb(secondLbId), (row) => row.currentExistence === 'Deleted', existenceShape)
      }],
      ['load balancer', async () => {
        if (lbId === '') {
          return
        }
        const lb = await readLb(lbId)
        if (lb.desiredExistence === 'Exists') {
          await pollUntil('load balancer at rest', () => readLb(lbId), (row) => row.transition === null, existenceShape)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
        }
        await pollUntil('load balancer deleted', () => readLb(lbId), (row) => row.currentExistence === 'Deleted', existenceShape)
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
        if (originalQuota !== null) {
          expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
        }
      }],
      ['sessions', closeSessions],
    ])
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Networking/Network/Network.cs BeginLoadBalancer — Incus refuses a load
  // balancer on a network with no uplink, and a network without public IPv6 has none
  test('LB-01 a load balancer on a network without public IPv6 is 422 LOAD_BALANCER_NEEDS_PUBLIC_IPV6', async () => {
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: runNetworkId, listeners: [http], backends: [{ vmId: '00000000-0000-0000-0000-000000000001' }] }, newKey()),
      422, 'LOAD_BALANCER_NEEDS_PUBLIC_IPV6')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/LoadBalancer/LoadBalancerSpecRules.cs (LoadBalancerSpecRules)
  test('LB-02 no listener, or the same protocol and port twice, is 400 VALIDATION_ERROR', async () => {
    const backends = [{ vmId: '00000000-0000-0000-0000-000000000001' }]
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: runNetworkId, listeners: [], backends }, newKey()), 400, 'VALIDATION_ERROR')
    expectError(await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: runNetworkId, listeners: [http, { ...http, targetPort: 9090 }], backends }, newKey()), 400, 'VALIDATION_ERROR')
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Compute/LoadBalancer/LoadBalancerVip.cs (LoadBalancerVip) — interface id 0:0:1:n of the /64
  test('LB-03 on an IPv6 network with a VM: 202, then Exists, VIP <64>::1:1, the VM as backend', async () => {
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
    const lb = await pollUntil('load balancer on Incus', () => readLb(lbId), (row) => row.currentExistence === 'Exists' && row.transition === null, existenceShape)
    const prefix = subnet.replace(/::\/64$/, '')
    log(`LB-03 vip=${lb.vip} subnet=${subnet}`)
    expect(lb.vip).toBe(`${prefix}::1:1`)
    expect(lb.listeners).toEqual([http])
    expect(lb.backends).toEqual([{ vmId }])
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

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/DeleteVmCommandHandler.cs HandleAsync (VM_IS_LOAD_BALANCER_BACKEND) — refused, the load balancer is not
  // edited behind the customer's back
  test('LB-05 deleting a VM a load balancer sends to is 422 VM_IS_LOAD_BALANCER_BACKEND', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    expectError(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`), 422, 'VM_IS_LOAD_BALANCER_BACKEND')
    expect((await get('tenant', `/v1/tenant/vms/${vmId}`)).desiredExistence).toBe('Exists')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/LoadBalancer/RenameLoadBalancerEndpoint.cs (Patch, 204, no provider command);
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/RenameLoadBalancerCommandHandler.cs HandleAsync
  // (LOAD_BALANCER_NAME_TAKEN) · titan-ops features/load-balancer/design.md#lb-rename
  test('LB-09 rename is 204 and keeps the VIP; a name another load balancer holds is 409 LOAD_BALANCER_NAME_TAKEN', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const created = await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: `rg-lb2-${RUN}`, networkId: ipv6NetworkId, listeners: [http], backends: [{ vmId }] }, newKey())
    expectStatus(created, 202)
    secondLbId = bodyOf(created).loadBalancerId
    const before = await pollUntil('second load balancer on Incus', () => readLb(secondLbId),
      (row) => row.currentExistence === 'Exists' && row.transition === null, existenceShape)
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
    await pollUntil('second load balancer deleted', () => readLb(secondLbId), (row) => row.currentExistence === 'Deleted', existenceShape)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/DeleteLoadBalancerCommandHandler.cs HandleAsync
  test('LB-06 delete is 202, then Deleted; a repeat is 202; one request and one outcome each', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    const reply = await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`)
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    await pollUntil('load balancer deleted', () => readLb(lbId), (row) => row.currentExistence === 'Deleted', existenceShape)
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
    const listed = await get('tenant', '/v1/tenant/load-balancers') as any[]
    expect(listed.map((row) => row.id)).not.toContain(lbId)
    const actions = await activityOf(lbName)
    log(`LB-06 activity ${lbName}: ${actions.join(', ')}`)
    for (const action of ['create_requested', 'created', 'update_requested', 'updated', 'delete_requested', 'deleted']) {
      expect(countOf(actions, `load_balancer.${action}`), action).toBe(1)
    }
  })

  test('LB-07 once the load balancer is Deleted, its VM deletes', async () => {
    test.skip(lbId === '', 'LB-03 did not create a load balancer')
    await deleteVmAndWait(vmId)
    vmId = ''
  })
})
