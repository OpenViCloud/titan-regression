import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, startLog } from './api'
import { RUN, RUN_CIDR, RUN_NETWORK_PREFIX, activityOf, countOf, envOf, listNetworks, networkUsable, waitNetwork } from './fixtures'

// Cases NET-01..07, NET-09 and NET-10 of plan.md (NET-08 reads the Incus host). This module creates the run
// network and leaves it for the modules after it; network-lifecycle deletes it.
test.describe.serial('network', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  const name = `${RUN_NETWORK_PREFIX}${RUN}`
  const key = newKey()
  let networkId = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('network')
    useBrowser(browser)
    // A run network left by an earlier run would take beta-user's only network slot: remove it first.
    for (const old of await listNetworks()) {
      if (old.name.startsWith(RUN_NETWORK_PREFIX) && old.desiredExistence === 'Exists') {
        log(`setup: deleting the run network of an earlier run ${old.name}`)
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${old.id}`), 202)
        await waitNetwork('setup old run network', old.id, (n) => n.currentExistence === 'Deleted')
      }
    }
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/IdempotencyMiddleware.cs InvokeAsync (IDEMPOTENCY_KEY_REQUIRED)
  test('NET-01 create without Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED and makes nothing', async () => {
    const { clusterId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name, clusterId, cidr: RUN_CIDR }), 400, 'IDEMPOTENCY_KEY_REQUIRED')
    expect((await listNetworks()).some((n) => n.name === name)).toBe(false)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (name, CIDR and cluster checks);
  // the reconciler reports Created (OpenViCloud/titan-ops:docs/features/network/design.md#network-lifecycle)
  test('NET-02 create with a key and a cidr is 202 {networkId}, then Created and Exists', async () => {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name, clusterId, cidr: RUN_CIDR }, key)
    expectStatus(reply, 202)
    networkId = bodyOf(reply).networkId
    expect(Object.keys(bodyOf(reply))).toEqual(['networkId'])
    const network = await waitNetwork('NET-02', networkId, networkUsable)
    expect(network.cidr).toBe(RUN_CIDR)
    // ACT-02: one request row, one outcome row (OpenViCloud/titan-ops:docs/features/activity/design.md#request-and-outcome-names)
    const actions = await activityOf(name)
    log(`ACT-02 network ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'network.create_requested')).toBe(1)
    expect(countOf(actions, 'network.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/IdempotencyMiddleware.cs InvokeAsync (IdempotencyDecision.Replay) — the same key and body replay the stored answer
  test('NET-03 the same key and body answers the same networkId and makes no second network', async () => {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name, clusterId, cidr: RUN_CIDR }, key)
    expectStatus(reply, 202)
    expect(bodyOf(reply).networkId).toBe(networkId)
    expect((await listNetworks()).filter((n) => n.name === name).length).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/IdempotencyMiddleware.cs InvokeAsync (IDEMPOTENCY_KEY_REUSED)
  test('NET-04 the same key with another body is 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { clusterId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name: `${name}-other`, clusterId, cidr: '10.78.0.0/24' }, key),
      422, 'IDEMPOTENCY_KEY_REUSED')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (NetworkAggregate.Create) — quota refuses in the factory, after the name and CIDR checks
  test('NET-05 a second network (new name, free CIDR) past maxNetworks is 422 NETWORK_QUOTA_EXCEEDED', async () => {
    const { clusterId } = await envOf()
    const tenant = await get('tenant', '/v1/tenant')
    const live = (await listNetworks()).filter((n) => n.desiredExistence === 'Exists').length
    log(`NET-05 maxNetworks=${tenant.maxNetworks} live=${live}`)
    test.skip(live < tenant.maxNetworks, `N/A: the tenant still has room (maxNetworks=${tenant.maxNetworks}, live=${live})`)
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net2-${RUN}`, clusterId, cidr: '10.77.0.0/24' }, newKey()),
      422, 'NETWORK_QUOTA_EXCEEDED')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/RenameNetworkEndpoint.cs (Configure: Patch("v1/tenant/networks/{networkId:guid}"), 204;
  // HandleAsync: SendNoContentAsync)
  test('NET-06 rename is 204 with no body and GET shows the new name', async () => {
    const newName = `${name}-renamed`
    const reply = await call('tenant', 'PATCH', `/v1/tenant/networks/${networkId}`, { name: newName })
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    expect((await get('tenant', `/v1/tenant/networks/${networkId}`)).name).toBe(newName)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (HasCidrOverlapAsync) — the CIDR check runs before quota
  test('NET-07 a second network whose CIDR overlaps the run network is 422 NETWORK_CIDR_OVERLAP', async () => {
    const { clusterId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net3-${RUN}`, clusterId, cidr: '10.76.0.128/25' }, newKey()),
      422, 'NETWORK_CIDR_OVERLAP')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs FreePublicIpv6Async — a
  // cluster whose cluster names no IPv6 block refuses; a cluster with one is skipped here
  test('NET-10 a network asking for public IPv6 in a cluster without an IPv6 block is 422 IPV6_NOT_AVAILABLE', async () => {
    const { clusterId } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    const cluster = clusters.find((c) => c.clusterId === clusterId)
    log(`NET-10 cluster=${clusterId} ipv6Block=${cluster?.providerSettings?.ipv6Block ?? null}`)
    test.skip(Boolean(cluster?.providerSettings?.ipv6Block), 'the cluster has an IPv6 block')
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net6-${RUN}`, clusterId, enablePublicIpv6: true }, newKey()),
      422, 'IPV6_NOT_AVAILABLE')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Networking/Network/NetworkOwnership.cs RequireNetworkAsync — admin-test reads beta-user's
  // run network, so a broken check could only touch a test network
  test("NET-09 another tenant's network is 404 NETWORK_NOT_FOUND", async () => {
    expectError(await call('admin', 'GET', `/v1/tenant/networks/${networkId}`), 404, 'NETWORK_NOT_FOUND')
    expectError(await call('admin', 'DELETE', `/v1/tenant/networks/${networkId}`), 404, 'NETWORK_NOT_FOUND')
    expect((await get('tenant', `/v1/tenant/networks/${networkId}`)).desiredExistence).toBe('Exists')
  })

})
