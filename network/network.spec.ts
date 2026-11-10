import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, startLog } from './api'
import { cleanUp } from './clean-up'
import { RUN, RUN_CIDR, RUN_NETWORK_PREFIX, activityOf, countOf, envOf, listNetworks, networkUsable, waitNetwork } from './fixtures'

// Cases NET-01..07, NET-09..13 and NET-22..24 of plan.md (NET-08, NET-20, NET-21 and NET-25 read the Incus host;
// NET-14..19 are measured by tests of the control plane). This module creates the run network and leaves it for the
// modules after it; network-lifecycle deletes it. NET-11..13 and NET-24 need more networks than beta-user may hold:
// they raise maxNetworks (NET-13 also lowers maxPublicIpv6), give it back right after the case and again in afterAll,
// and delete every network they made.

// What counts toward MaxNetworks and MaxPublicIpv6: not Deleting, Deleted, NotFound or Failed
// (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs OccupiesQuota, OccupiesPublicIpv6Quota).
function countsTowardQuota(n: any): boolean {
  return n.status !== 'Deleting' && n.status !== 'Deleted' && n.status !== 'NotFound' && n.status !== 'Failed'
}

// The 16 bytes of an IPv6 address or prefix (`2001:db8:0:1a01::/64` → its address part).
function ipv6Bytes(text: string): number[] {
  const address = text.split('/')[0]
  const [head, tail] = address.includes('::') ? address.split('::') : [address, undefined]
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const zeros = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length
  const groups = [...headGroups, ...Array(zeros).fill('0'), ...tailGroups]
  expect(groups.length, `${text} has 8 groups`).toBe(8)
  const bytes: number[] = []
  for (const group of groups) {
    const value = parseInt(group, 16)
    bytes.push(value >> 8, value & 0xff)
  }
  return bytes
}

function first56Bits(text: string): string {
  return ipv6Bytes(text).slice(0, 7).join('.')
}
test.describe.serial('network', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  const name = `${RUN_NETWORK_PREFIX}${RUN}`
  const key = newKey()
  let networkId = ''
  let tenantId = ''
  // The caps this module may change, as they were before it: restored right after each case and in afterAll.
  let original: { maxVms: number, maxNetworks: number, maxPublicIpv6: number } | null = null
  // Every extra network a case made (NET-11..13, NET-24), deleted in that case's finally and again in afterAll.
  const extra: string[] = []
  // NET-11..13: the networks with public IPv6 and their /64.
  let ipv6A = ''
  let ipv6B = ''
  let ipv6C = ''
  let subnetA = ''
  let subnetB = ''

  async function quotaRow(): Promise<any> {
    const all = await get('admin', '/v1/tenants') as any[]
    const row = all.find((t) => t.id === tenantId)
    expect(row, `tenant ${tenantId} in GET /v1/tenants`).toBeDefined()
    return row
  }

  // maxVms and maxNetworks are mandatory in the body; a cap not sent keeps its value
  // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs UpdateQuotaValidator, UpdateQuotaRequest).
  async function setQuota(body: Record<string, number>): Promise<void> {
    log(`quota ← ${JSON.stringify(body)}`)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, body), 204)
  }

  async function restoreQuota(): Promise<void> {
    if (original !== null) {
      await setQuota(original)
    }
  }

  async function countingNetworks(): Promise<any[]> {
    return (await listNetworks()).filter(countsTowardQuota)
  }

  // Waits for the network's request to end, asks for its delete if it still wants to exist, waits for Deleted.
  async function deleteNetwork(id: string): Promise<void> {
    const settled = await waitNetwork(`network ${id} at rest`, id, (n) => n.status !== 'Creating' && n.status !== 'Deleting')
    if (settled.status !== 'Deleted') {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${id}`), 202)
    }
    await waitNetwork(`network ${id} deleted`, id, (n) => n.status === 'Deleted')
  }

  // Every network gets its turn even when one fails; a network whose delete failed stays listed for afterAll.
  async function deleteExtraNetworks(): Promise<void> {
    await cleanUp([...extra].map((id): [string, () => Promise<void>] => [`network ${id}`, async () => {
      await deleteNetwork(id)
      forget(id)
    }]))
  }

  function forget(id: string): void {
    const at = extra.indexOf(id)
    if (at >= 0) {
      extra.splice(at, 1)
    }
  }

  async function clusterIpv6Block(): Promise<string | null> {
    const { clusterId } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    return clusters.find((c) => c.clusterId === clusterId)?.providerSettings?.ipv6Block ?? null
  }

  async function createIpv6Network(label: string): Promise<{ id: string, subnet: string }> {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net6-${label}-${RUN}`, clusterId, enablePublicIpv6: true }, newKey())
    expectStatus(reply, 202)
    const id = bodyOf(reply).networkId as string
    extra.push(id)
    const network = await waitNetwork(`IPv6 network ${label}`, id, networkUsable)
    log(`IPv6 network ${label} ${id} subnet=${network.publicIpv6Subnet}`)
    return { id, subnet: network.publicIpv6Subnet }
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('network')
    useBrowser(browser)
    tenantId = (await get('tenant', '/v1/tenant')).id
    const row = await quotaRow()
    original = { maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxPublicIpv6: row.maxPublicIpv6 }
    log(`quota before: ${JSON.stringify(original)}`)
    // A run network left by an earlier run would take beta-user's only network slot: remove it first.
    for (const old of await listNetworks()) {
      if (old.name.startsWith(RUN_NETWORK_PREFIX) && old.status !== 'Deleting' && old.status !== 'Deleted') {
        log(`setup: deleting the run network of an earlier run ${old.name}`)
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${old.id}`), 202)
        await waitNetwork('setup old run network', old.id, (n) => n.status === 'Deleted')
      }
    }
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    await cleanUp([
      ['quota', restoreQuota],
      ['extra networks', deleteExtraNetworks],
      ['sessions', closeSessions],
    ])
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/IdempotencyMiddleware.cs InvokeAsync (IDEMPOTENCY_KEY_REQUIRED)
  test('NET-01 create without Idempotency-Key is 400 IDEMPOTENCY_KEY_REQUIRED and makes nothing', async () => {
    const { clusterId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name, clusterId, cidr: RUN_CIDR }), 400, 'IDEMPOTENCY_KEY_REQUIRED')
    expect((await listNetworks()).some((n) => n.name === name)).toBe(false)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (name, CIDR and cluster checks);
  // the create's Done carries the status Incus shows (titan-ops features/network/design.md#network-lifecycle); a body
  // without the two policies gets Allow for both (OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/Contracts/CreateNetworkCommand.cs
  // CreateNetworkCommand defaults; titan-ops features/network/design.md#firewall-default-policy)
  test('NET-02 create with a key and a cidr is 202 {networkId}, then Created and Exists, both default policies Allow', async () => {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name, clusterId, cidr: RUN_CIDR }, key)
    expectStatus(reply, 202)
    networkId = bodyOf(reply).networkId
    expect(Object.keys(bodyOf(reply))).toEqual(['networkId'])
    const network = await waitNetwork('NET-02', networkId, networkUsable)
    expect(network.cidr).toBe(RUN_CIDR)
    expect(network.defaultIngressPolicy).toBe('Allow')
    expect(network.defaultEgressPolicy).toBe('Allow')
    // ACT-02: one request row, one outcome row (titan-ops features/activity/design.md#request-and-outcome-names)
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

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (TenantQuotaGate) — quota is asked after the name and CIDR checks
  test('NET-05 a second network (new name, free CIDR) past maxNetworks is 422 NETWORK_QUOTA_EXCEEDED', async () => {
    const { clusterId } = await envOf()
    const tenant = await get('tenant', '/v1/tenant')
    const live = (await listNetworks()).filter((n) => n.status !== 'Deleting' && n.status !== 'Deleted').length
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

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (ClusterConfig.HasPublicIpv6) — a
  // cluster without an IPv6 block or an OVN uplink refuses; a cluster with a block is skipped here
  test('NET-10 a network asking for public IPv6 in a cluster without an IPv6 block is 422 IPV6_NOT_AVAILABLE', async () => {
    const { clusterId } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    const cluster = clusters.find((c) => c.clusterId === clusterId)
    log(`NET-10 cluster=${clusterId} ipv6Block=${cluster?.providerSettings?.ipv6Block ?? null}`)
    test.skip(Boolean(cluster?.providerSettings?.ipv6Block), 'the cluster has an IPv6 block')
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net6-${RUN}`, clusterId, enablePublicIpv6: true }, newKey()),
      422, 'IPV6_NOT_AVAILABLE')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Networking/Network/NetworkOwnership.cs RequireNetworkAsync — admin-test reads
  // beta-user's run network, so a broken check could only touch a test network; rename looks the network up the same
  // way (OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/RenameNetworkCommandHandler.cs HandleAsync);
  // titan-ops architecture/tenancy-and-admin.md#tenant-isolation
  test("NET-09 another tenant's network is 404 NETWORK_NOT_FOUND for GET, DELETE and PATCH", async () => {
    const before = await get('tenant', `/v1/tenant/networks/${networkId}`)
    expectError(await call('admin', 'GET', `/v1/tenant/networks/${networkId}`), 404, 'NETWORK_NOT_FOUND')
    expectError(await call('admin', 'DELETE', `/v1/tenant/networks/${networkId}`), 404, 'NETWORK_NOT_FOUND')
    expectError(await call('admin', 'PATCH', `/v1/tenant/networks/${networkId}`, { name: `rg-netx-${RUN}` }), 404, 'NETWORK_NOT_FOUND')
    const after = await get('tenant', `/v1/tenant/networks/${networkId}`)
    expect(after.status).not.toBe('Deleting')
    expect(after.status).not.toBe('Deleted')
    expect(after.name).toBe(before.name)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/CreateNetworkValidator.cs CreateNetworkValidator (NetworkName.Pattern,
  // NetworkName.MaxLength = 100, Ipv4Cidr.Pattern then Ipv4Cidr.Parse, IsInsideAPrivateRangeOrNotACidr for enablePublicIpv6) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/RenameNetworkValidator.cs RenameNetworkValidator — the validator
  // answers before the handler, so (f) needs no IPv6 block; titan-ops features/network/user-stories.md#us-net-intent-01
  test('NET-22 a bad name or cidr on create, and a bad name on rename, are 400 VALIDATION_ERROR and change nothing', async () => {
    const { clusterId } = await envOf()
    const before = await get('tenant', `/v1/tenant/networks/${networkId}`)
    const countBefore = (await listNetworks()).length
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['(a) name starts with a hyphen', { name: `-net-${RUN}`, clusterId }],
      ['(b) name with spaces', { name: `rg net ${RUN}`, clusterId }],
      ['(c) name of 101 characters', { name: `rg${'a'.repeat(99)}`, clusterId }],
      ['(d) cidr prefix 40', { name: `rg-netv-${RUN}`, clusterId, cidr: '10.0.0.0/40' }],
      ['(e) cidr octet 300', { name: `rg-netv-${RUN}`, clusterId, cidr: '10.0.0.300/24' }],
      ['(f) public IPv6 with a cidr outside the private ranges', { name: `rg-netv-${RUN}`, clusterId, cidr: '100.64.0.0/24', enablePublicIpv6: true }],
    ]
    for (const [label, body] of bodies) {
      log(`NET-22 ${label}`)
      expectError(await call('tenant', 'POST', '/v1/tenant/networks', body, newKey()), 400, 'VALIDATION_ERROR')
    }
    log('NET-22 rename to -bad')
    expectError(await call('tenant', 'PATCH', `/v1/tenant/networks/${networkId}`, { name: '-bad' }), 400, 'VALIDATION_ERROR')
    expect((await listNetworks()).length).toBe(countBefore)
    expect((await get('tenant', `/v1/tenant/networks/${networkId}`)).name).toBe(before.name)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (ExistsByNameAsync
  // before HasCidrOverlapAsync and TenantQuotaGate) — so no maxNetworks raise is needed; titan-ops features/network/design.md#network-lifecycle
  test('NET-23 a create with the name of the run network is 409 NETWORK_NAME_TAKEN and makes nothing', async () => {
    const { clusterId } = await envOf()
    const runName = (await get('tenant', `/v1/tenant/networks/${networkId}`)).name as string
    const countBefore = (await listNetworks()).length
    expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name: runName, clusterId, cidr: '10.78.0.0/24' }, newKey()),
      409, 'NETWORK_NAME_TAKEN')
    const after = await listNetworks()
    expect(after.length).toBe(countBefore)
    expect(after.filter((n) => n.name === runName).length).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/NetworkRepository.cs HasCidrOverlapAsync (a create that waits holds
  // RequestedCidr) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs AddFirewallRule (IsUsable ⇒
  // FIREWALL_NETWORK_NOT_READY), Delete (CreateIsWaiting ⇒ NETWORK_INVALID_STATE), Rename (Deleted ⇒ NETWORK_INVALID_STATE) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/RenameNetworkCommandHandler.cs HandleAsync (ExistsByNameAsync
  // ⇒ NETWORK_NAME_TAKEN) · OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/Contracts/CreateNetworkCommand.cs
  // (FirewallPolicy is a number on /v1: Allow = 0, Deny = 1); titan-ops features/network/user-stories.md#us-net-intent-02 ·
  // titan-ops features/network/design.md#network-lifecycle · titan-ops features/network/design.md#firewall-default-policy
  test('NET-24 while a create waits: its range is held, no rule, no delete; then policies, rename and delete', async () => {
    test.setTimeout(20 * 60_000)
    const { clusterId } = await envOf()
    const net2 = `rg-net2-${RUN}`
    const runName = (await get('tenant', `/v1/tenant/networks/${networkId}`)).name as string
    try {
      await setQuota({ maxVms: original!.maxVms, maxNetworks: original!.maxNetworks + 1 })
      const reply = await call('tenant', 'POST', '/v1/tenant/networks',
        { name: net2, clusterId, cidr: '10.77.0.0/24', defaultIngressPolicy: 1, defaultEgressPolicy: 0 }, newKey())
      expectStatus(reply, 202)
      const id = bodyOf(reply).networkId as string
      extra.push(id)
      const first = await get('tenant', `/v1/tenant/networks/${id}`)
      const overlap = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net3-${RUN}`, clusterId, cidr: '10.77.0.0/25' }, newKey())
      const rule = await call('tenant', 'POST', `/v1/tenant/networks/${id}/firewall-rules`,
        { direction: 'Ingress', protocol: 'TCP', startPort: 22, endPort: 22, cidr: '0.0.0.0/0' }, newKey())
      const del = await call('tenant', 'DELETE', `/v1/tenant/networks/${id}`)
      const second = await get('tenant', `/v1/tenant/networks/${id}`)
      log(`NET-24 status before=${first.status} after=${second.status}; (a) ${overlap.status} (b) ${rule.status} (c) ${del.status}`)
      if (first.status === 'Creating' && second.status === 'Creating') {
        expectError(overlap, 422, 'NETWORK_CIDR_OVERLAP')
        expectError(rule, 422, 'FIREWALL_NETWORK_NOT_READY')
        expectError(del, 422, 'NETWORK_INVALID_STATE')
      } else {
        // The create ended before or between the two reads: (a)-(c) may have met a usable network and are not measured.
        const reason = `N/A (a)-(c): the create was not waiting at both reads (status ${first.status}, then ${second.status})`
        log(`NET-24 ${reason}`)
        test.info().annotations.push({ type: 'skip', description: reason })
      }
      expect((await listNetworks()).some((n) => n.name === `rg-net3-${RUN}`)).toBe(false)

      const settled = await waitNetwork('NET-24 rg-net2 at rest', id, (n) => n.status !== 'Creating' && n.status !== 'Deleting')
      expect(settled.defaultIngressPolicy).toBe('Deny')
      expect(settled.defaultEgressPolicy).toBe('Allow')
      if (settled.status !== 'Deleted') {
        expectError(await call('tenant', 'PATCH', `/v1/tenant/networks/${id}`, { name: runName }), 409, 'NETWORK_NAME_TAKEN')
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${id}`), 202)
      } else {
        log('NET-24 rg-net2 was already being deleted: the rename onto a taken name is not measured')
      }
      await waitNetwork('NET-24 rg-net2 deleted', id, (n) => n.status === 'Deleted')
      expectError(await call('tenant', 'PATCH', `/v1/tenant/networks/${id}`, { name: `rg-net2r-${RUN}` }), 422, 'NETWORK_INVALID_STATE')
      expect((await get('tenant', `/v1/tenant/networks/${id}`)).name).toBe(net2)
    } finally {
      await cleanUp([
        ['quota', restoreQuota],
        ['extra networks', deleteExtraNetworks],
      ])
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Services/NetworkRoutes.cs GiveAsync ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ClusterIpv6Route/ClusterIpv6Route.cs SubnetIn (route n is the n-th /64 of the /56) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Networking/Network/Contracts/NetworkQueryResult.cs (PublicIpv6Subnet);
  // titan-ops features/network/design.md#ipv6-public
  test('NET-11 two networks with public IPv6 get two different /64 of the cluster block', async () => {
    test.setTimeout(20 * 60_000)
    const block = await clusterIpv6Block()
    log(`NET-11 ipv6Block=${block}`)
    test.skip(!block, 'the cluster has no IPv6 block')
    // Room for a and b now, and for NET-13's refused d (c takes a's place): beta-user may hold one network.
    const counting = (await countingNetworks()).length
    await setQuota({ maxVms: original!.maxVms, maxNetworks: Math.max(original!.maxNetworks, counting) + 3 })
    const a = await createIpv6Network('a')
    ipv6A = a.id
    subnetA = a.subnet
    const b = await createIpv6Network('b')
    ipv6B = b.id
    subnetB = b.subnet
    for (const subnet of [subnetA, subnetB]) {
      expect(subnet).toMatch(/^[0-9a-f:]+::\/64$/i)
    }
    expect(subnetA).not.toBe(subnetB)
    expect(first56Bits(subnetA)).toBe(first56Bits(subnetB))
    expect(first56Bits(subnetA)).toBe(first56Bits(block!))
    expect((await get('tenant', `/v1/tenant/networks/${ipv6A}`)).publicIpv6Subnet).toBe(subnetA)
    expect((await get('tenant', `/v1/tenant/networks/${ipv6B}`)).publicIpv6Subnet).toBe(subnetB)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Services/NetworkRoutes.cs FinishOperationAsync (a delete's Done gives the route back) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ClusterIpv6Route/ClusterIpv6Route.cs NextToGive (never-released first, then
  // released longest ago); titan-ops features/network/design.md#ipv6-public
  test('NET-12 the /64 of a deleted network is not the next one given', async () => {
    test.setTimeout(20 * 60_000)
    test.skip(ipv6A === '' || ipv6B === '', 'NET-11 made no IPv6 networks')
    await deleteNetwork(ipv6A)
    forget(ipv6A)
    const c = await createIpv6Network('c')
    ipv6C = c.id
    log(`NET-12 a=${subnetA} b=${subnetB} c=${c.subnet}`)
    expect(c.subnet).not.toBe(subnetA)
    expect(c.subnet).not.toBe(subnetB)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs HandleAsync (TenantQuotaGate
  // Network, then PublicIpv6) · OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs EnsureHasRoom
  // (count >= cap); titan-ops features/network/design.md#ipv6-public · titan-ops features/tenant/design.md#quota-caps
  test('NET-13 at maxPublicIpv6 another IPv6 network is 422 IPV6_QUOTA_EXCEEDED and makes nothing', async () => {
    test.setTimeout(20 * 60_000)
    test.skip(ipv6B === '' || ipv6C === '', 'NET-11 and NET-12 made no IPv6 networks')
    const { clusterId } = await envOf()
    try {
      const counting = await countingNetworks()
      const withSubnet = counting.filter((n) => n.publicIpv6Subnet !== null).length
      // maxNetworks stays raised, with room for one more, so the network cap is not what refuses.
      const maxNetworks = Math.max((await quotaRow()).maxNetworks, counting.length + 1)
      await setQuota({ maxVms: original!.maxVms, maxNetworks, maxPublicIpv6: withSubnet })
      expectError(await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net6-d-${RUN}`, clusterId, enablePublicIpv6: true }, newKey()),
        422, 'IPV6_QUOTA_EXCEEDED')
      expect((await listNetworks()).some((n) => n.name === `rg-net6-d-${RUN}`)).toBe(false)
    } finally {
      await cleanUp([
        ['quota', restoreQuota],
        ['extra networks', deleteExtraNetworks],
      ])
    }
  })
})
