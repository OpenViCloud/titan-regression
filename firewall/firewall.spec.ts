import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { cleanUp } from './clean-up'
import { runNetwork } from './fixtures'

// Cases FW-01..05 and FW-07..08 of plan.md: FW-07 reads the Incus host, FW-08 is NOT COVERED; rules of a
// deleted network are NETL-02.

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/ValueObjects/TenantQuota.cs DefaultMaxFirewallRulesPerNetwork — no API reads the cap
const MAX_RULES_PER_NETWORK = 20

function rulePath(networkId: string): string {
  return `/v1/tenant/networks/${networkId}/firewall-rules`
}

function ruleShape(r: any): string {
  return `state=${r.currentState} existence=${r.currentExistence} desired=${r.desiredExistence} transition=${r.transition} failure=${r.requestFailureReason}`
}

// The server's count: desired Exists and (Exists, or its create waits) — titan-ops features/network/design.md#firewall-rule-quota-counting
function counts(r: any): boolean {
  return r.desiredExistence === 'Exists' && (r.currentExistence === 'Exists' || r.transition === 'Creating')
}

function cidrOf(i: number): string {
  return `10.${90 + Math.floor(i / 200)}.${i % 200}.0/24`
}

test.describe.serial('firewall', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  let networkId = ''
  const made: string[] = []

  async function readRule(id: string): Promise<any> {
    const rows = await get('tenant', rulePath(networkId)) as any[]
    const row = rows.find((r) => r.id === id)
    if (row === undefined) {
      return { currentExistence: 'Gone' }
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
    const rule = await pollUntil(`rule ${id} settled`, () => readRule(id), (r) => r.transition === null || r.currentExistence === 'Gone', ruleShape)
    if (rule.currentExistence === 'Gone' || rule.desiredExistence === 'Deleted') {
      return
    }
    expectStatus(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 204)
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('firewall')
    useBrowser(browser)
    networkId = (await runNetwork()).id
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    // A rule whose delete failed is not polled for Gone: each poll can take minutes, and the time limit of this hook
    // would end it before the sessions close and before cleanUp reports.
    const deleted: string[] = []
    const steps: Array<[string, () => Promise<void>]> = []
    for (const id of made) {
      steps.push([`delete rule ${id}`, async () => {
        await deleteWhenReady(id)
        deleted.push(id)
      }])
    }
    steps.push(['deleted rules gone', async () => {
      for (const id of deleted) {
        await pollUntil(`rule ${id} gone`, () => readRule(id), (r) => r.currentExistence === 'Gone', ruleShape)
      }
    }])
    steps.push(['close sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/CreateFirewallRuleEndpoint.cs (Configure: Post("v1/tenant/networks/{networkId:guid}/firewall-rules");
  // HandleAsync: SendAsync(result, 201)); the reconciler
  // reports the ACL line (titan-ops features/network/design.md#firewall-rule-status)
  test('FW-01 a rule is 201 {ruleId}, then enabled and Exists', async () => {
    const id = await createRule(0)
    const rule = await pollUntil('FW-01', () => readRule(id), (r) => r.currentState === 'enabled' && r.transition === null, ruleShape)
    expect(rule.currentExistence).toBe('Exists')
    // ACT-02: the activity row is named by the rule's label, which carries its CIDR
    // (OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/FirewallRule/CreateFirewallRuleCommandHandler.cs HandleAsync,
    // activity.Stage("firewall_rule.create_requested"))
    const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ action: string, resourceName: string }>
    const actions = rows.filter((r) => r.resourceName.includes(cidrOf(0))).map((r) => r.action)
    log(`ACT-02 rule ${cidrOf(0)}: ${actions.join(', ')}`)
    expect(actions.filter((a) => a === 'firewall_rule.create_requested').length).toBe(1)
    expect(actions.filter((a) => a === 'firewall_rule.created').length).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/ChildEntities/FirewallRule.cs RequestDelete (CreateIsWaiting ⇒ FIREWALL_RULE_NOT_READY)
  test('FW-02 deleting a rule whose create still waits is 422 FIREWALL_RULE_NOT_READY', async () => {
    const id = await createRule(1)
    const rule = await readRule(id)
    log(`FW-02 right after create: ${ruleShape(rule)}`)
    expect(rule.transition).toBe('Creating')
    expectError(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 422, 'FIREWALL_RULE_NOT_READY')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/DeleteFirewallRuleEndpoint.cs (Configure: Delete("v1/tenant/networks/{networkId:guid}/firewall-rules/{ruleId:guid}");
  // HandleAsync: SendNoContentAsync)
  test('FW-03 deleting a rule that Exists is 204, it leaves the list, a repeat is 204', async () => {
    const id = made[0]
    const reply = await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`)
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    expectStatus(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 204)
    await pollUntil('FW-03', () => readRule(id), (r) => r.currentExistence === 'Gone', ruleShape)
    expectStatus(await call('tenant', 'DELETE', `${rulePath(networkId)}/${id}`), 204)
    const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ action: string, resourceName: string }>
    const actions = rows.filter((r) => r.resourceName.includes(cidrOf(0))).map((r) => r.action)
    log(`ACT-02 rule ${cidrOf(0)} after delete: ${actions.join(', ')}`)
    expect(actions.filter((a) => a === 'firewall_rule.delete_requested').length).toBe(1)
    expect(actions.filter((a) => a === 'firewall_rule.deleted').length).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/Tenant.cs EnsureCanCreateFirewallRule; a delete asked stops counting
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
})

