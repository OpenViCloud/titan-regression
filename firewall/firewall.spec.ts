import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { cleanUp } from './clean-up'
import { RUN, activityIds, activitySince, envOf, existenceShape as ruleShape, listNetworks, networkUsable, runNetwork, waitNetwork } from './fixtures'

// Cases FW-01..05 and FW-07..13 of plan.md: FW-07 reads the Incus host, FW-08 is NOT COVERED; rules of a
// deleted network are NETL-02. FW-10 and FW-11 need a second network, which beta-user may not hold: they raise
// maxNetworks (FW-11 also sets maxFirewallRulesPerNetwork to 0), give the quota back right after the case and again
// in afterAll, and delete the network they made.

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/ValueObjects/TenantQuota.cs DefaultMaxFirewallRulesPerNetwork — no API reads the cap
const MAX_RULES_PER_NETWORK = 20

function rulePath(networkId: string): string {
  return `/v1/tenant/networks/${networkId}/firewall-rules`
}

// The server's count: not Deleting, Deleted, NotFound or Failed — titan-ops features/network/design.md#firewall-rule-quota-counting
function counts(r: any): boolean {
  return r.status !== 'Deleting' && r.status !== 'Deleted' && r.status !== 'NotFound' && r.status !== 'Failed'
}

function cidrOf(i: number): string {
  return `10.${90 + Math.floor(i / 200)}.${i % 200}.0/24`
}

test.describe.serial('firewall', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  let networkId = ''
  const made: string[] = []
  let tenantId = ''
  // The caps this module may change, as they were before it.
  let original: { maxVms: number, maxNetworks: number, maxFirewallRulesPerNetwork: number } | null = null
  // Second networks of FW-10 and FW-11, deleted in the case's finally and again in afterAll.
  const extra: string[] = []
  // The feed before FW-01 asked for rule 0: every run names rule 0 by the same CIDR, so ACT-02 counts only the rows that
  // appeared since (activitySince of fixtures.ts).
  let feedBeforeRuleZero = new Set<string>()

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

  // Room for one more network than the tenant holds now (every status but Deleting, Deleted, NotFound and Failed —
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs OccupiesQuota).
  async function maxNetworksWithRoom(): Promise<number> {
    const counting = (await listNetworks()).filter((n) =>
      n.status !== 'Deleting' && n.status !== 'Deleted' && n.status !== 'NotFound' && n.status !== 'Failed').length
    return Math.max(original!.maxNetworks, counting + 1)
  }

  async function createSecondNetwork(kind: string, cidr: string): Promise<string> {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-${kind}-${RUN}`, clusterId, cidr }, newKey())
    expectStatus(reply, 202)
    const id = bodyOf(reply).networkId as string
    extra.push(id)
    return id
  }

  // Waits for the network's request to end, asks for its delete if it still wants to exist, waits for Deleted; its
  // rules go with it (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.Deletion.cs DeleteSucceeded).
  async function deleteNetwork(id: string): Promise<void> {
    const settled = await waitNetwork(`network ${id} at rest`, id, (n) => n.status !== 'Creating' && n.status !== 'Deleting')
    if (settled.status !== 'Deleted') {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${id}`), 202)
    }
    await waitNetwork(`network ${id} deleted`, id, (n) => n.status === 'Deleted')
  }

  async function deleteExtraNetworks(): Promise<void> {
    await cleanUp([...extra].map((id): [string, () => Promise<void>] => [`network ${id}`, async () => {
      await deleteNetwork(id)
      extra.splice(extra.indexOf(id), 1)
    }]))
  }

  async function ruleIds(): Promise<string[]> {
    return (await get('tenant', rulePath(networkId)) as any[]).map((r) => r.id as string)
  }

  async function readRule(id: string): Promise<any> {
    const rows = await get('tenant', rulePath(networkId)) as any[]
    const row = rows.find((r) => r.id === id)
    if (row === undefined) {
      return { status: 'Gone' }
    }
    return row
  }

  async function createRule(i: number): Promise<string> {
    const reply = await call('tenant', 'POST', rulePath(networkId),
      { direction: 'Ingress', protocol: 'TCP', startPort: 1000 + i, endPort: 1000 + i, cidr: cidrOf(i) }, newKey())
    expectStatus(reply, 201)
    expect(Object.keys(bodyOf(reply))).toEqual(['ruleId'])
    const id = bodyOf(reply).ruleId as string
    made.push(id)
    return id
  }

  async function deleteWhenReady(id: string): Promise<void> {
    const rule = await pollUntil(`rule ${id} settled`, () => readRule(id), (r) => r.status !== 'Creating' && r.status !== 'Deleting', ruleShape)
    if (rule.status === 'Gone' || rule.status === 'Deleted') {
      return
    }
    expectStatus(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 204)
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('firewall')
    useBrowser(browser)
    networkId = (await runNetwork()).id
    tenantId = (await get('tenant', '/v1/tenant')).id
    const row = await quotaRow()
    original = { maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxFirewallRulesPerNetwork: row.maxFirewallRulesPerNetwork }
    log(`quota before: ${JSON.stringify(original)}`)
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    // A rule whose delete failed is not polled for Gone: each poll can take minutes, and the time limit of this hook
    // would end it before the sessions close and before cleanUp reports.
    const deleted: string[] = []
    const steps: Array<[string, () => Promise<void>]> = [
      ['quota', restoreQuota],
      ['second networks', deleteExtraNetworks],
    ]
    for (const id of made) {
      steps.push([`delete rule ${id}`, async () => {
        await deleteWhenReady(id)
        deleted.push(id)
      }])
    }
    steps.push(['deleted rules gone', async () => {
      for (const id of deleted) {
        await pollUntil(`rule ${id} gone`, () => readRule(id), (r) => r.status === 'Gone', ruleShape)
      }
    }])
    steps.push(['close sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/CreateFirewallRuleEndpoint.cs (Configure: Post("v1/tenant/networks/{networkId:guid}/firewall-rules");
  // HandleAsync: SendAsync(result, 201)); the create's
  // Done carries the state of the ACL line (titan-ops features/network/design.md#firewall-rule-status)
  test('FW-01 a rule is 201 {ruleId}, then enabled', async () => {
    feedBeforeRuleZero = await activityIds()
    const id = await createRule(0)
    const rule = await pollUntil('FW-01', () => readRule(id), (r) => r.status === 'enabled', ruleShape)
    expect(rule.status).toBe('enabled')
    // ACT-02: the activity row is named by the rule's label, which carries its CIDR
    // (OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/FirewallRule/CreateFirewallRuleCommandHandler.cs HandleAsync,
    // activity.Stage("firewall_rule.create_requested"))
    const actions = await activitySince(feedBeforeRuleZero, cidrOf(0))
    log(`ACT-02 rule ${cidrOf(0)}, rows since FW-01: ${actions.join(', ')}`)
    expect(actions.filter((a) => a === 'firewall_rule.create_requested').length).toBe(1)
    expect(actions.filter((a) => a === 'firewall_rule.created').length).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Entities/FirewallRule.Deletion.cs Delete (CreateIsWaiting ⇒ FIREWALL_RULE_NOT_READY)
  test('FW-02 deleting a rule whose create still waits is 422 FIREWALL_RULE_NOT_READY', async () => {
    const id = await createRule(1)
    const rule = await readRule(id)
    log(`FW-02 right after create: ${ruleShape(rule)}`)
    expect(rule.status).toBe('Creating')
    expectError(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 422, 'FIREWALL_RULE_NOT_READY')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Networking/Network/NetworkOwnership.cs RequireNetworkForUpdateAsync — both the
  // create and the delete look the network up for the caller's tenant first; admin-test is another tenant;
  // titan-ops architecture/http-contract.md#tenant-scoping
  test("FW-13 another tenant's create and delete of a rule on the run network are 404 NETWORK_NOT_FOUND", async () => {
    const id = made[0]
    const before = await ruleIds()
    expectError(await call('admin', 'POST', rulePath(networkId),
      { direction: 'Ingress', protocol: 'TCP', startPort: 3000, endPort: 3000, cidr: cidrOf(160) }, newKey()), 404, 'NETWORK_NOT_FOUND')
    expectError(await call('admin', 'DELETE', `${rulePath(networkId)}/${id}`), 404, 'NETWORK_NOT_FOUND')
    const rule = await readRule(id)
    log(`FW-13 rule of FW-01: ${ruleShape(rule)}`)
    expect(rule.status).toBe('enabled')
    const after = await ruleIds()
    expect(after.filter((r) => !before.includes(r))).toEqual([])
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/DeleteFirewallRuleEndpoint.cs (Configure: Delete("v1/tenant/networks/{networkId:guid}/firewall-rules/{ruleId:guid}");
  // HandleAsync: SendNoContentAsync)
  test('FW-03 deleting a rule that Exists is 204, it leaves the list, a repeat is 204', async () => {
    const id = made[0]
    const reply = await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`)
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    expectStatus(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 204)
    await pollUntil('FW-03', () => readRule(id), (r) => r.status === 'Gone', ruleShape)
    expectStatus(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 204)
    const actions = await activitySince(feedBeforeRuleZero, cidrOf(0))
    log(`ACT-02 rule ${cidrOf(0)} after delete, rows since FW-01: ${actions.join(', ')}`)
    expect(actions.filter((a) => a === 'firewall_rule.delete_requested').length).toBe(1)
    expect(actions.filter((a) => a === 'firewall_rule.deleted').length).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs EnsureHasRoom; a delete asked stops counting
  // (titan-ops features/network/design.md#firewall-rule-quota-counting)
  test('FW-04 the rule past MaxFirewallRulesPerNetwork is 422 FIREWALL_QUOTA_EXCEEDED; a delete frees a slot', async () => {
    const live = (await get('tenant', rulePath(networkId)) as any[]).filter(counts).length
    log(`FW-04 live rules before: ${live}`)
    const missing = MAX_RULES_PER_NETWORK - live
    for (let i = 0; i < missing; i++) {
      await createRule(2 + i)
    }
    const count = (await get('tenant', rulePath(networkId)) as any[]).filter(counts).length
    expect(count).toBe(MAX_RULES_PER_NETWORK)
    expectError(await call('tenant', 'POST', rulePath(networkId),
      { direction: 'Ingress', protocol: 'TCP', startPort: 2000, endPort: 2000, cidr: cidrOf(150) }, newKey()), 422, 'FIREWALL_QUOTA_EXCEEDED')
    // Free one slot: the newest rule, once it Exists, asked to be deleted.
    const last = made[made.length - 1]
    await deleteWhenReady(last)
    await createRule(151)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/FirewallRule/DeleteFirewallRuleCommandHandler.cs HandleAsync (FIREWALL_RULE_NOT_FOUND) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Networking/Network/NetworkOwnership.cs RequireNetworkAsync (NETWORK_NOT_FOUND)
  test('FW-05 an unknown ruleId is 404 FIREWALL_RULE_NOT_FOUND, an unknown networkId 404 NETWORK_NOT_FOUND', async () => {
    expectError(await call('tenant', 'DELETE', `${rulePath(networkId)}/${randomUUID()}`), 404, 'FIREWALL_RULE_NOT_FOUND')
    expectError(await call('tenant', 'DELETE', `${rulePath(randomUUID())}/${made[1]}`), 404, 'NETWORK_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/FirewallRule/CreateFirewallRuleCommandHandler.cs HandleAsync
  // (RequireNetworkForUpdateAsync, then TenantQuotaGate on FirewallRuleQuotaUsage) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/NetworkRepository.cs FindByIdForUpdateAsync ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs FirewallRuleQuotaUsage — the second request waits for the
  // network's row and counts the first; titan-ops features/network/design.md#firewall-rule-quota-counting ·
  // titan-ops architecture/code-structure.md#child-entity
  test('FW-09 two rules at once for the last slot: one 201, one 422 FIREWALL_QUOTA_EXCEEDED', async () => {
    // Bring the network to cap − 1 rules that count: a delete asked stops counting at once.
    let counting = (await get('tenant', rulePath(networkId)) as any[]).filter(counts)
    while (counting.length > MAX_RULES_PER_NETWORK - 1) {
      const victim = [...made].reverse().find((id) => counting.some((r) => r.id === id))
      expect(victim, 'a rule this module made counts toward the cap').toBeDefined()
      await deleteWhenReady(victim!)
      counting = (await get('tenant', rulePath(networkId)) as any[]).filter(counts)
    }
    for (let i = counting.length; i < MAX_RULES_PER_NETWORK - 1; i++) {
      await createRule(170 + i)
    }
    counting = (await get('tenant', rulePath(networkId)) as any[]).filter(counts)
    log(`FW-09 rules counting before: ${counting.length}`)
    expect(counting.length).toBe(MAX_RULES_PER_NETWORK - 1)

    const body = (i: number) => ({ direction: 'Ingress', protocol: 'TCP', startPort: 4000 + i, endPort: 4000 + i, cidr: cidrOf(190 + i) })
    const replies = await Promise.all([
      call('tenant', 'POST', rulePath(networkId), body(0), newKey()),
      call('tenant', 'POST', rulePath(networkId), body(1), newKey()),
    ])
    log(`FW-09 replies: ${replies.map((r) => `${r.status} ${r.text.slice(0, 120)}`).join(' | ')}`)
    for (const reply of replies) {
      if (reply.status === 201) {
        made.push(bodyOf(reply).ruleId)
      }
    }
    const created = replies.filter((r) => r.status === 201)
    const refused = replies.filter((r) => r.status !== 201)
    expect(created.length).toBe(1)
    expect(Object.keys(bodyOf(created[0]))).toEqual(['ruleId'])
    expect(refused.length).toBe(1)
    expectError(refused[0], 422, 'FIREWALL_QUOTA_EXCEEDED')
    expect((await get('tenant', rulePath(networkId)) as any[]).filter(counts).length).toBe(MAX_RULES_PER_NETWORK)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/CreateFirewallRuleValidator.cs CreateFirewallRuleValidator
  // (InclusiveBetween(PortRange.MinPort, PortRange.MaxPort), StartIsAtOrBeforeEnd, Null() ports for ICMP/All, FirewallCidr.Parse) — the
  // validator answers before the handler, so the full network does not matter; titan-ops features/network/user-stories.md#us-net-intent-01
  test('FW-12 a bad port, port range, ICMP port or cidr is 400 VALIDATION_ERROR and adds no rule', async () => {
    const before = await ruleIds()
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['(a) port 70000', { direction: 'Ingress', protocol: 'TCP', startPort: 70000, endPort: 70000, cidr: '0.0.0.0/0' }],
      ['(b) start after end', { direction: 'Ingress', protocol: 'TCP', startPort: 90, endPort: 80, cidr: '0.0.0.0/0' }],
      ['(c) ICMP with ports', { direction: 'Ingress', protocol: 'ICMP', startPort: 80, endPort: 80, cidr: '0.0.0.0/0' }],
      ['(d) cidr octet 300', { direction: 'Ingress', protocol: 'TCP', startPort: 22, endPort: 22, cidr: '10.0.0.300/24' }],
    ]
    for (const [label, body] of bodies) {
      log(`FW-12 ${label}`)
      expectError(await call('tenant', 'POST', rulePath(networkId), body, newKey()), 400, 'VALIDATION_ERROR')
    }
    const after = await ruleIds()
    expect(after.filter((r) => !before.includes(r))).toEqual([])
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Networking/Network/NetworkOwnership.cs RequireFirewallRule — the rule is the
  // network's child, so network A does not hold B's rule ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/FirewallRule/DeleteFirewallRuleCommandHandler.cs HandleAsync;
  // titan-ops features/network/design.md#firewall-rule-soft-delete
  test("FW-10 deleting network B's rule through network A is 404 FIREWALL_RULE_NOT_FOUND and leaves it", async () => {
    test.setTimeout(20 * 60_000)
    try {
      await setQuota({ maxVms: original!.maxVms, maxNetworks: await maxNetworksWithRoom() })
      const b = await createSecondNetwork('netfwb', '10.80.0.0/24')
      await waitNetwork('FW-10 network B usable', b, networkUsable)
      const reply = await call('tenant', 'POST', rulePath(b),
        { direction: 'Ingress', protocol: 'TCP', startPort: 22, endPort: 22, cidr: '0.0.0.0/0' }, newKey())
      expectStatus(reply, 201)
      const ruleOfB = bodyOf(reply).ruleId as string
      const readOnB = async () => (await get('tenant', rulePath(b)) as any[]).find((r) => r.id === ruleOfB) ?? { status: 'Gone' }
      await pollUntil('FW-10 rule on B', readOnB, (r) => r.status === 'enabled', ruleShape)

      expectError(await call('tenant', 'DELETE', `${rulePath(networkId)}/${ruleOfB}`), 404, 'FIREWALL_RULE_NOT_FOUND')
      const rule = await readOnB()
      log(`FW-10 rule on B after: ${ruleShape(rule)}`)
      expect(rule.status).toBe('enabled')
    } finally {
      await cleanUp([
        ['quota', restoreQuota],
        ['second networks', deleteExtraNetworks],
      ])
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/FirewallRule/CreateFirewallRuleCommandHandler.cs HandleAsync
  // (TenantQuotaGate.EnsureHasRoom before Network.AddFirewallRule) · OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs
  // EnsureHasRoom (count >= cap: a cap of 0 refuses the first); titan-ops architecture/code-structure.md#quota-gate
  test('FW-11 with a cap of 0, a rule on a network still being created is FIREWALL_QUOTA_EXCEEDED, not FIREWALL_NETWORK_NOT_READY', async () => {
    test.setTimeout(20 * 60_000)
    try {
      await setQuota({ maxVms: original!.maxVms, maxNetworks: await maxNetworksWithRoom(), maxFirewallRulesPerNetwork: 0 })
      const b = await createSecondNetwork('netfwq', '10.81.0.0/24')
      const reply = await call('tenant', 'POST', rulePath(b),
        { direction: 'Ingress', protocol: 'TCP', startPort: 22, endPort: 22, cidr: '0.0.0.0/0' }, newKey())
      const network = await get('tenant', `/v1/tenant/networks/${b}`)
      log(`FW-11 network after the rule request: status=${network.status}; rule ${reply.status} ${reply.text.slice(0, 200)}`)
      // Still Creating after the reply ⇒ it was not Created when the rule was asked for.
      expect(network.status).toBe('Creating')
      expectError(reply, 422, 'FIREWALL_QUOTA_EXCEEDED')
      await restoreQuota()
      await waitNetwork('FW-11 network created', b, networkUsable)
    } finally {
      await cleanUp([
        ['quota', restoreQuota],
        ['second networks', deleteExtraNetworks],
      ])
    }
  })
})
