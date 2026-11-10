import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { type Reply, bodyOf, call, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { cleanUp } from './clean-up'
import {
  RUN, createVm, deleteVmAndWait, envOf, existenceShape, listNetworks, networkUsable, readVolume, runNetwork, runs,
  vmShape, volumeShape, waitNetwork, waitVm, waitVolume,
} from './fixtures'

// Cases CC-05..12 of plan.md: two requests on one resource at the same moment. A file of its own, so a red CC-03 (the
// seeded invoice) does not skip them. One VM at a time: CC-07, CC-10, CC-11, CC-12 and CC-06 share one small VM, on an
// IPv6 network of the module when the cluster names an IPv6 block (CC-12's load balancer needs one), else on the run
// network. Every extra network raises maxNetworks for its create only: the cap is given back as soon as the create is
// answered (the quota gate reads it at create only), and again in afterAll.

function statusOf(reply: Reply): string {
  return `${reply.status} ${bodyOf(reply).code || ''}`.trim()
}

// What counts toward MaxNetworks: not Deleting, Deleted, NotFound or Failed
// (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs OccupiesQuota).
function countsTowardQuota(n: any): boolean {
  return n.status !== 'Deleting' && n.status !== 'Deleted' && n.status !== 'NotFound' && n.status !== 'Failed'
}

function plainShape(r: any): string {
  return `status=${r.status} failure=${r.requestFailureReason}`
}

// Waiting on its own command: network and firewall rule share the same two (Creating, Deleting), volume and load
// balancer have their own kinds (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Network/Network.cs,
// Entities/FirewallRule.cs, Titan.Domain/Aggregates/Volume/Volume.cs, Titan.Domain/Aggregates/LoadBalancer/LoadBalancer.cs).
function networkPending(n: any): boolean {
  return n.status === 'Creating' || n.status === 'Deleting'
}

function rulePending(r: any): boolean {
  return r.status === 'Creating' || r.status === 'Deleting'
}

function volumePending(v: any): boolean {
  return v.status === 'Creating' || v.status === 'Attaching' || v.status === 'Detaching' || v.status === 'Deleting'
}

function lbPending(row: any): boolean {
  return row.status === 'Creating' || row.status === 'Updating' || row.status === 'Deleting'
}

function vmSnapshotPending(s: any): boolean {
  return s.status === 'Creating' || s.status === 'Reverting' || s.status === 'Deleting'
}

async function feedIds(): Promise<Set<string>> {
  const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ id: string }>
  return new Set(rows.map((r) => r.id))
}

async function newActionsOf(before: Set<string>, named: (resourceName: string) => boolean): Promise<string[]> {
  const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ id: string, action: string, resourceName: string }>
  return rows.filter((r) => !before.has(r.id) && named(r.resourceName)).map((r) => r.action)
}

// Waits for the outcome row, then a little longer: a second outcome (the bug) would come right after the first.
async function expectOneRequestOneOutcome(label: string, before: Set<string>, named: (resourceName: string) => boolean,
  requested: string, outcome: string): Promise<void> {
  await pollUntil(`${label} outcome recorded`, () => newActionsOf(before, named), (actions) => actions.includes(outcome),
    (actions) => actions.join(','), 2 * 60_000, 3_000)
  await sleep(10_000)
  const actions = await newActionsOf(before, named)
  log(`${label} activity: ${actions.join(', ')}`)
  expect(actions.filter((a) => a === requested).length, `${label} ${requested}`).toBe(1)
  expect(actions.filter((a) => a === outcome).length, `${label} ${outcome}`).toBe(1)
}

async function twoAtOnce(label: string, method: string, path: string): Promise<string[]> {
  const replies = await Promise.all([call('tenant', method, path), call('tenant', method, path)])
  const answers = replies.map(statusOf)
  log(`${label} answers: ${answers.join(' | ')}`)
  return answers
}

test.describe.serial('concurrency-requests', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  let tenantId = ''
  // The caps this file may change, as they were before it.
  let original: { maxVms: number, maxNetworks: number } | null = null
  // Every network this file made; each deleted in its case's finally and again in afterAll.
  const networks: string[] = []
  // The shared VM, its network (when IPv6), its volume and snapshot, CC-09's rule and CC-12's load balancer.
  let hostNetworkId = ''
  let vmId = ''
  let volumeId = ''
  let snapshotId = ''
  let ruleNetworkId = ''
  let ruleId = ''
  let lbId = ''

  const vmName = `rg-cchost-${RUN}`
  const volumeName = `rg-ccvold-${RUN}`
  const snapshotName = `rg-ccsnap-${RUN}`
  const lbName = `rg-cclb-${RUN}`
  // CC-09's rule: its activity rows are named by the rule's own words, which end with its CIDR
  // (OpenViCloud/titan-control-plane:Titan.Application/Services/Networking/FirewallRule/FirewallRuleLabel.cs Describe).
  const ruleCidr = '10.88.7.0/24'

  async function clusterIpv6Block(): Promise<string | null> {
    const { clusterId } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    return clusters.find((c) => c.clusterId === clusterId)?.providerSettings?.ipv6Block ?? null
  }

  // maxVms and maxNetworks are mandatory in the body; a cap not sent keeps its value
  // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs UpdateQuotaValidator, UpdateQuotaRequest).
  async function setMaxNetworks(maxNetworks: number): Promise<void> {
    const body = { maxVms: original!.maxVms, maxNetworks }
    log(`quota ← ${JSON.stringify(body)}`)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, body), 204)
  }

  async function restoreQuota(): Promise<void> {
    if (original !== null) {
      log(`quota ← ${JSON.stringify(original)}`)
      expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, original), 204)
    }
  }

  // Room for `more` networks beside the ones that count now.
  async function roomFor(more: number): Promise<void> {
    const counting = (await listNetworks()).filter(countsTowardQuota).length
    await setMaxNetworks(Math.max(original!.maxNetworks, counting) + more)
  }

  // Waits for the network's request to end, asks for its delete if it still wants to exist, waits for Deleted.
  async function deleteNetwork(id: string): Promise<void> {
    const settled = await waitNetwork(`network ${id} at rest`, id, (n) => !networkPending(n))
    if (settled.status !== 'Deleted') {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${id}`), 202)
    }
    await waitNetwork(`network ${id} deleted`, id, (n) => n.status === 'Deleted')
    const at = networks.indexOf(id)
    if (at >= 0) {
      networks.splice(at, 1)
    }
  }

  async function createNetwork(body: Record<string, unknown>): Promise<string> {
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', body, newKey())
    expectStatus(reply, 202)
    const id = bodyOf(reply).networkId as string
    networks.push(id)
    return id
  }

  async function readRule(): Promise<any> {
    const rows = await get('tenant', `/v1/tenant/networks/${ruleNetworkId}/firewall-rules`) as any[]
    // A Deleted rule is kept but not listed
    // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/FirewallRuleRepository.cs ListByNetworkAsync).
    return rows.find((r) => r.id === ruleId) ?? { status: 'Deleted' }
  }

  async function readSnapshot(): Promise<any> {
    const reply = await call('tenant', 'GET', `/v1/tenant/vms/${vmId}/snapshots`)
    if (reply.status === 404) {
      return { status: 'Deleted' }
    }
    expectStatus(reply, 200)
    // The list leaves Deleted snapshots out
    // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmSnapshotRepository.cs FindByVmIdAsync).
    return (bodyOf(reply) as any[]).find((s) => s.id === snapshotId) ?? { status: 'Deleted' }
  }

  const readLb = () => get('tenant', `/v1/tenant/load-balancers/${lbId}`)

  async function deleteLb(): Promise<void> {
    if (lbId === '') {
      return
    }
    const lb = await pollUntil('load balancer at rest', readLb, (row) => !lbPending(row), existenceShape)
    if (lb.status !== 'Deleted') {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
    }
    await pollUntil('load balancer deleted', readLb, (row) => row.status === 'Deleted', existenceShape)
    lbId = ''
  }

  async function deleteVolume(): Promise<void> {
    if (volumeId === '') {
      return
    }
    let v = await waitVolume('volume at rest', volumeId, (row) => !volumePending(row))
    if (v.status !== 'Deleted') {
      if (v.currentAttachedVmId !== null || v.desiredAttachedVmId !== null) {
        expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/detach`), 202)
        v = await waitVolume('volume detached', volumeId, (row) => row.currentAttachedVmId === null && !volumePending(row))
      }
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`), 202)
    }
    await waitVolume('volume deleted', volumeId, (row) => row.status === 'Deleted')
    volumeId = ''
  }

  // A snapshot create or revert in flight makes the VM Snapshotting, which refuses its delete (VM_INVALID_STATUS); a waiting delete does not.
  async function deleteVm(): Promise<void> {
    if (vmId === '') {
      return
    }
    if (snapshotId !== '') {
      await pollUntil('snapshot at rest', readSnapshot, (s) => s.status !== 'Creating' && s.status !== 'Reverting', plainShape)
    }
    await deleteVmAndWait(vmId)
    vmId = ''
  }

  async function deleteHost(): Promise<void> {
    await cleanUp([
      ['load balancer', deleteLb],
      ['volume', deleteVolume],
      ['vm', deleteVm],
      ['host network', async () => {
        if (hostNetworkId !== '') {
          await deleteNetwork(hostNetworkId)
          hostNetworkId = ''
        }
      }],
    ])
  }

  // The shared VM, made once by the first case that needs it: on an IPv6 network of its own when the cluster has a
  // block, so CC-12 can put a load balancer in front of it.
  async function host(): Promise<string> {
    if (vmId !== '') {
      return vmId
    }
    const { clusterId, smallTier } = await envOf()
    let networkId = (await runNetwork()).id
    if (await clusterIpv6Block()) {
      await roomFor(1)
      try {
        hostNetworkId = await createNetwork({ name: `rg-net6-cc-${RUN}`, clusterId, enablePublicIpv6: true })
      } finally {
        await restoreQuota()
      }
      await waitNetwork('host network usable', hostNetworkId, networkUsable)
      networkId = hostNetworkId
    }
    vmId = await createVm(vmName, smallTier, networkId)
    await waitVm('host VM runs', vmId, runs)
    return vmId
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('concurrency-requests')
    useBrowser(browser)
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    original = { maxVms: tenant.maxVms, maxNetworks: tenant.maxNetworks }
    log(`quota before: ${JSON.stringify(original)}`)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    await cleanUp([
      ['quota', restoreQuota],
      ['host', deleteHost],
      ['rule', async () => {
        if (ruleId === '') {
          return
        }
        const rule = await pollUntil('rule at rest', readRule, (r) => !rulePending(r), plainShape)
        if (rule.status !== 'Deleted') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${ruleNetworkId}/firewall-rules/${ruleId}`), 204)
        }
        await pollUntil('rule deleted', readRule, (r) => r.status === 'Deleted', plainShape)
      }],
      ...[...networks].map((id): [string, () => Promise<void>] => [`network ${id}`, () => deleteNetwork(id)]),
      ['sessions', closeSessions],
    ])
  })

  // titan-ops features/network/design.md#ipv6-public · OpenViCloud/titan-control-plane:Titan.Domain/Services/NetworkRoutes.cs GiveAsync
  // (LockFreeAsync: the second create waits on the free routes' lock, then takes the next one) ·
  // OpenViCloud/titan-control-plane:Titan.Tests/Infrastructure/Integration/ClusterIpv6RouteDbTests.cs
  // (TwoCreatesAtOnce_TheSecondWaits_ThenTakesTheNextRoute)
  test('CC-05 two networks with public IPv6 created at once: two 202, two different /64', async () => {
    const block = await clusterIpv6Block()
    log(`CC-05 ipv6Block=${block}`)
    test.skip(!block, 'the cluster has no IPv6 block')
    const { clusterId } = await envOf()
    const tenant = (await get('admin', '/v1/tenants') as any[]).find((t) => t.id === tenantId)
    const withIpv6 = (await listNetworks()).filter((n) => countsTowardQuota(n) && n.publicIpv6Subnet !== null).length
    expect(tenant.maxPublicIpv6 - withIpv6, `room for two IPv6 networks (maxPublicIpv6=${tenant.maxPublicIpv6}, held=${withIpv6})`)
      .toBeGreaterThanOrEqual(2)
    const ids: string[] = []
    try {
      await roomFor(2)
      let replies: Reply[] = []
      try {
        replies = await Promise.all(['x', 'y'].map((label) => call('tenant', 'POST', '/v1/tenant/networks',
          { name: `rg-net6-${label}-${RUN}`, clusterId, enablePublicIpv6: true }, newKey())))
      } finally {
        await restoreQuota()
      }
      for (const reply of replies) {
        if (reply.status === 202) {
          const id = bodyOf(reply).networkId as string
          ids.push(id)
          networks.push(id)
        }
      }
      log(`CC-05 answers: ${replies.map(statusOf).join(' | ')}`)
      expect(replies.map(statusOf)).toEqual(['202', '202'])
      const subnets: string[] = []
      for (const id of ids) {
        const network = await waitNetwork(`CC-05 network ${id}`, id, networkUsable)
        log(`CC-05 ${network.name} subnet=${network.publicIpv6Subnet}`)
        expect(network.publicIpv6Subnet).toMatch(/^[0-9a-f:]+::\/64$/i)
        subnets.push(network.publicIpv6Subnet)
      }
      expect(subnets[0]).not.toBe(subnets[1])
    } finally {
      await cleanUp(ids.map((id): [string, () => Promise<void>] => [`network ${id}`, () => deleteNetwork(id)]))
    }
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/DeleteNetworkCommandHandler.cs (HandleAsync:
  // RequireNetworkForUpdateAsync, IsDeletedOrDeleting — the second waits on the row lock, then answers as a repeat)
  test('CC-08 two deletes of one network at once: two 202, one network.delete_requested, Deleted, one network.deleted', async () => {
    const { clusterId } = await envOf()
    const name = `rg-netcc-${RUN}`
    let id = ''
    try {
      await roomFor(1)
      try {
        id = await createNetwork({ name, clusterId, cidr: '10.79.0.0/24' })
      } finally {
        await restoreQuota()
      }
      await waitNetwork('CC-08 network usable', id, networkUsable)
      const before = await feedIds()
      const answers = await twoAtOnce('CC-08', 'DELETE', `/v1/tenant/networks/${id}`)
      log(`CC-08 right after: ${existenceShape(await get('tenant', `/v1/tenant/networks/${id}`))}`)
      expect(answers).toEqual(['202', '202'])
      await waitNetwork('CC-08 deleted', id, (n) => n.status === 'Deleted')
      await expectOneRequestOneOutcome('CC-08', before, (n) => n === name, 'network.delete_requested', 'network.deleted')
    } finally {
      if (id !== '' && networks.includes(id)) {
        await deleteNetwork(id)
      }
    }
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/FirewallRule/DeleteFirewallRuleCommandHandler.cs (HandleAsync:
  // RequireNetworkForUpdateAsync, IsDeletedOrDeleting) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/DeleteFirewallRuleEndpoint.cs
  // (SendNoContentAsync) · OpenViCloud/titan-control-plane:Titan.Tests/Infrastructure/Integration/NetworkRequestsDbTests.cs
  // (TwoDeletesOfOneRule_AtOnce_LeaveOneRequest_AndOneCommandRow)
  test('CC-09 two deletes of one rule at once: two 204, one firewall_rule.delete_requested, Deleted, one firewall_rule.deleted', async () => {
    ruleNetworkId = (await runNetwork()).id
    const created = await call('tenant', 'POST', `/v1/tenant/networks/${ruleNetworkId}/firewall-rules`,
      { direction: 'Ingress', protocol: 'TCP', startPort: 7007, endPort: 7007, cidr: ruleCidr }, newKey())
    expectStatus(created, 201)
    ruleId = bodyOf(created).ruleId as string
    // At rest with the ACL line applied: one of the Incus words (enabled/disabled/logged) or Unknown
    // (titan-ops features/network/design.md#firewall-rule-status).
    await pollUntil('CC-09 rule Exists', readRule, (r) => !['Creating', 'Deleting', 'NotFound', 'Failed', 'Deleted'].includes(r.status), plainShape)
    const before = await feedIds()
    const answers = await twoAtOnce('CC-09', 'DELETE', `/v1/tenant/networks/${ruleNetworkId}/firewall-rules/${ruleId}`)
    log(`CC-09 right after: ${plainShape(await readRule())}`)
    expect(answers).toEqual(['204', '204'])
    await pollUntil('CC-09 rule deleted', readRule, (r) => r.status === 'Deleted', plainShape)
    await expectOneRequestOneOutcome('CC-09', before, (n) => n.endsWith(` ${ruleCidr}`),
      'firewall_rule.delete_requested', 'firewall_rule.deleted')
    ruleId = ''
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/DetachVolumeCommandHandler.cs (HandleAsync:
  // RequireVolumeForUpdateAsync, detachIsWaiting) · OpenViCloud/titan-control-plane:Titan.Tests/Infrastructure/Integration/VolumeRequestsDbTests.cs
  // (TwoDetaches_AtOnce_LeaveOneRequest_AndOneCommandRow)
  test('CC-07 two detaches of one attached volume at once: two 202, one volume.detach_requested, not attached, one volume.detached', async () => {
    const vm = await host()
    const { clusterId, volumeOfferingId } = await envOf()
    const created = await call('tenant', 'POST', '/v1/tenant/volumes', { name: volumeName, volumeOfferingId, clusterId, sizeGb: 1 }, newKey())
    expectStatus(created, 202)
    volumeId = bodyOf(created).volumeId as string
    await waitVolume('CC-07 volume Exists', volumeId, (v) => v.status === 'Available')
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/attach`, { vmId: vm }), 202)
    await waitVolume('CC-07 attached at rest', volumeId, (v) => v.currentAttachedVmId === vm && !volumePending(v))
    const before = await feedIds()
    const answers = await twoAtOnce('CC-07', 'POST', `/v1/tenant/volumes/${volumeId}/detach`)
    log(`CC-07 right after: ${volumeShape(await readVolume(volumeId))}`)
    expect(answers).toEqual(['202', '202'])
    await waitVolume('CC-07 detached', volumeId, (v) => v.currentAttachedVmId === null && !volumePending(v))
    await expectOneRequestOneOutcome('CC-07', before, (n) => n === volumeName, 'volume.detach_requested', 'volume.detached')
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/RevertVmSnapshotCommandHandler.cs (HandleAsync:
  // RequireVmForUpdateAsync, alreadyReverting) · OpenViCloud/titan-control-plane:Titan.Tests/Infrastructure/Integration/VmSnapshotRequestsDbTests.cs
  // (TwoRevertsOfOneSnapshot_AtOnce_LeaveOneRequest_AndOneCommandRow)
  test('CC-10 two reverts of one snapshot at once: two 202, one vm_snapshot.revert_requested, at rest, one vm_snapshot.reverted', async () => {
    const vm = await host()
    const created = await call('tenant', 'POST', `/v1/tenant/vms/${vm}/snapshots`, { name: snapshotName }, newKey())
    expectStatus(created, 202)
    snapshotId = bodyOf(created).snapshotId as string
    await pollUntil('CC-10 snapshot Exists', readSnapshot, (s) => s.status === 'Available', plainShape)
    const before = await feedIds()
    const answers = await twoAtOnce('CC-10', 'POST', `/v1/tenant/vms/${vm}/snapshots/${snapshotId}/revert`)
    const right = await readSnapshot()
    log(`CC-10 right after: ${plainShape(right)}`)
    expect(answers).toEqual(['202', '202'])
    await pollUntil('CC-10 revert at rest', readSnapshot, (s) => !vmSnapshotPending(s), plainShape)
    // Only a revert still waiting when the second arrives makes the second a repeat; one already ended makes it a new
    // revert, which is right too, so that lap measures nothing.
    test.skip(!vmSnapshotPending(right), 'the revert had already ended when both answers were in: the second may have been a new revert')
    await expectOneRequestOneOutcome('CC-10', before, (n) => n === snapshotName, 'vm_snapshot.revert_requested', 'vm_snapshot.reverted')
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/DeleteVmSnapshotCommandHandler.cs (HandleAsync:
  // RequireVmForUpdateAsync, IsDeletedOrDeleting) · OpenViCloud/titan-control-plane:Titan.Tests/Infrastructure/Integration/VmSnapshotRequestsDbTests.cs
  // (TwoDeletesOfOneSnapshot_AtOnce_LeaveOneRequest_AndOneCommandRow)
  test('CC-11 two deletes of one snapshot at once: two 202, one vm_snapshot.delete_requested, Deleted, one vm_snapshot.deleted', async () => {
    test.skip(snapshotId === '', 'CC-10 made no snapshot')
    await pollUntil('CC-11 snapshot at rest', readSnapshot, (s) => s.status === 'Available', plainShape)
    const before = await feedIds()
    const answers = await twoAtOnce('CC-11', 'DELETE', `/v1/tenant/vms/${vmId}/snapshots/${snapshotId}`)
    log(`CC-11 right after: ${plainShape(await readSnapshot())}`)
    expect(answers).toEqual(['202', '202'])
    await pollUntil('CC-11 snapshot deleted', readSnapshot, (s) => s.status === 'Deleted', plainShape)
    await expectOneRequestOneOutcome('CC-11', before, (n) => n === snapshotName, 'vm_snapshot.delete_requested', 'vm_snapshot.deleted')
    snapshotId = ''
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/LoadBalancer/DeleteLoadBalancerCommandHandler.cs (HandleAsync:
  // RequireLoadBalancerForUpdateAsync, IsDeletedOrDeleting) ·
  // OpenViCloud/titan-control-plane:Titan.Tests/Infrastructure/Integration/LoadBalancerRequestsDbTests.cs
  // (TwoDeletesOfOneLoadBalancer_AtOnce_LeaveOneRequest_AndOneCommandRow)
  test('CC-12 two deletes of one load balancer at once: two 202, one load_balancer.delete_requested, Deleted, one load_balancer.deleted', async () => {
    const block = await clusterIpv6Block()
    test.skip(!block, 'the cluster has no IPv6 block')
    const vm = await host()
    const created = await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: lbName, networkId: hostNetworkId, listeners: [{ protocol: 'TCP', port: 80, targetPort: 8080 }], backends: [{ vmId: vm }] }, newKey())
    expectStatus(created, 202)
    lbId = bodyOf(created).loadBalancerId as string
    await pollUntil('CC-12 load balancer Exists', readLb, (row) => row.status === 'Available', existenceShape)
    const before = await feedIds()
    const answers = await twoAtOnce('CC-12', 'DELETE', `/v1/tenant/load-balancers/${lbId}`)
    log(`CC-12 right after: ${existenceShape(await readLb())}`)
    expect(answers).toEqual(['202', '202'])
    await pollUntil('CC-12 deleted', readLb, (row) => row.status === 'Deleted', existenceShape)
    await expectOneRequestOneOutcome('CC-12', before, (n) => n === lbName, 'load_balancer.delete_requested', 'load_balancer.deleted')
    lbId = ''
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request · titan-ops architecture/resource-lifecycle.md#invariants ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/StopVmCommandHandler.cs (HandleAsync: RequireVmForUpdateAsync,
  // Vm.IsStopWaitingOrStopped). Last of the VM's cases: its finally deletes the VM, its volume and its network.
  test('CC-06 two stops of one running VM at once: two 202, one vm.stop_requested, Stopped, one vm.stopped', async () => {
    try {
      const vm = await host()
      await waitVm('CC-06 running at rest', vm, runs)
      const before = await feedIds()
      const answers = await twoAtOnce('CC-06', 'POST', `/v1/tenant/vms/${vm}/stop`)
      log(`CC-06 right after: ${vmShape(await get('tenant', `/v1/tenant/vms/${vm}`))}`)
      expect(answers).toEqual(['202', '202'])
      await waitVm('CC-06 stopped', vm, (v) => v.status === 'Stopped')
      await expectOneRequestOneOutcome('CC-06', before, (n) => n === vmName, 'vm.stop_requested', 'vm.stopped')
    } finally {
      await deleteHost()
    }
  })
})
