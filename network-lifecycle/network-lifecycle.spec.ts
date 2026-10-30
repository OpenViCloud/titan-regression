import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { RUN_CIDR, activityOf, countOf, envOf, listNetworks, networkUsable, runNetwork, waitNetwork } from './fixtures'

// Cases NETL-01..03 of plan.md. Runs after every module that uses the run network: it deletes it.
test.describe.serial('network-lifecycle', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  const ruleCidr = '10.89.0.0/24'
  let networkId = ''
  let networkName = ''
  let recreatedId = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('network-lifecycle')
    useBrowser(browser)
    const network = await runNetwork()
    networkId = network.id
    networkName = network.name
    // NETL-02 needs a rule on the network when it is deleted.
    const reply = await call('tenant', 'POST', `/v1/tenant/networks/${networkId}/firewall-rules`,
      { direction: 'Ingress', protocol: 'TCP', startPort: 443, endPort: 443, cidr: ruleCidr }, newKey())
    expectStatus(reply, 201)
    const ruleId = bodyOf(reply).ruleId
    await pollUntil('NETL rule exists', async () => {
      const rows = await get('tenant', `/v1/tenant/networks/${networkId}/firewall-rules`) as any[]
      return rows.find((r) => r.id === ruleId)
    }, (r) => r.currentExistence === 'Exists' && r.transition === null, (r) => `existence=${r.currentExistence} transition=${r.transition}`)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    if (recreatedId !== '') {
      await waitNetwork('recreated settles', recreatedId, (n) => n.transition === null)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${recreatedId}`), 202)
      await waitNetwork('recreated deleted', recreatedId, (n) => n.currentExistence === 'Deleted')
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/DeleteNetworkEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/DeleteNetworkCommandHandler.cs HandleAsync (alreadyRequestedOrDone)
  test('NETL-01 deleting the run network is 202, then Deleted; a repeat is 202 and records nothing', async () => {
    const vms = (await get('tenant', '/v1/tenant/vms') as any[]).filter((v) => v.networkId === networkId)
    expect(vms, 'every VM on the run network is gone before this module').toEqual([])
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}`), 202)
    const network = await waitNetwork('NETL-01', networkId, (n) => n.currentExistence === 'Deleted')
    expect(network.desiredExistence).toBe('Deleted')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}`), 202)
    expect((await listNetworks()).some((n) => n.id === networkId)).toBe(false)
    const actions = await activityOf(networkName)
    log(`ACT-02 network ${networkName}: ${actions.join(', ')}`)
    expect(countOf(actions, 'network.delete_requested')).toBe(1)
    expect(countOf(actions, 'network.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/UpdateNetworkStatusCommandHandler.cs HandleAsync (case Deleted:
  // rule.MarkDeleted()) marks every live rule Deleted; the rule list drops Deleted rows
  // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/FirewallRuleRepository.cs ListByNetworkAsync).
  // No outcome row: one is recorded only for a rule whose own delete was waiting
  // (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/FirewallRule/FirewallRule.cs MarkDeleted returns DeleteIsWaiting).
  test('NETL-02 the rule on the deleted network reaches Deleted with it', async () => {
    const rules = await get('tenant', `/v1/tenant/networks/${networkId}/firewall-rules`) as any[]
    log(`NETL-02 rules of the deleted network: ${rules.length}`)
    expect(rules).toEqual([])
    const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ action: string, resourceName: string }>
    const actions = rows.filter((r) => r.resourceName.includes(ruleCidr)).map((r) => r.action)
    expect(countOf(actions, 'firewall_rule.deleted')).toBe(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/NetworkRepository.cs ExistsByNameAsync — a Deleted network no longer holds its name
  test('NETL-03 a network may take the name and CIDR of a Deleted one', async () => {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name: networkName, clusterId, cidr: RUN_CIDR }, newKey())
    expectStatus(reply, 202)
    recreatedId = bodyOf(reply).networkId
    await waitNetwork('NETL-03', recreatedId, networkUsable)
  })
})
