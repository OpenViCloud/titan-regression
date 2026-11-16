import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { cleanUp } from './clean-up'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, existenceShape, getVm, networkUsable, readVolume,
  runs, vmShape, volumeShape, waitNetwork, waitVm, waitVolume } from './fixtures'
import { hold } from './host-hold'
import { incusName, phase4Key, projectOf } from './incus-names'

// Phase 4 of the release run (`release:regression-prd`; README.md §Phase 4): resources that the
// agent's commands on the Incus host and from the Internet act on. At each HOLD (lib/host-hold.ts) the spec logs what it
// holds and waits for go-<step> or skip-<step>; then it reads the API for the expectation of plan.md. Everything it
// creates is deleted in afterAll, every step even when one fails (cleanUp); the caps it raises are given back.
// V is stored as the tenant's SSH key, U goes in vm A's cloud-init; the agent keeps the private halves and a third key X
// that Titan never sees (python3 phase4.py keys).
// OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/VmReports.cs (FixedFailureReason)
const VM_DELETE_FAILED = 'The VM could not be deleted. Please try again or contact support.'
const VM_CREATE_FAILED = 'VM provisioning failed due to a system error. Please try again or contact support.'
// Statuses outside every quota (OpenViCloud/titan-cloud-console:portal/src/lib/quota.ts, the control plane's OccupiesQuota)
const OUTSIDE = new Set(['Deleting', 'Deleted', 'NotFound', 'Failed'])
// Statuses that wait on a command of their own, per resource (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/*/Enums/*Status.cs at 8fd95ac)
const LB_PENDING = new Set(['Creating', 'Updating', 'Deleting'])
const RULE_PENDING = new Set(['Creating', 'Deleting'])
const SNAP_PENDING = new Set(['Creating', 'Reverting', 'Deleting'])
const GONE = new Set(['Gone', 'Deleted'])

// --bind :: : the load balancer reaches its backends on their IPv6 address (dual-stack server)
function userDataOf(label: string, marker: boolean, extraKey: string | null): string {
  const lines = ['#cloud-config', 'write_files:']
  if (marker) {
    lines.push('  - path: /var/lib/rg-marker', `    content: "rg-${RUN}-${label}\\n"`)
  }
  lines.push('  - path: /srv/www/index.html', `    content: "backend-${label}\\n"`)
  if (extraKey !== null) {
    lines.push('ssh_authorized_keys:', `  - ${extraKey}`)
  }
  lines.push('runcmd:', '  - [sh, -c, "nohup python3 -m http.server 8080 --bind :: --directory /srv/www >/var/log/rg-http.log 2>&1 &"]')
  return lines.join('\n') + '\n'
}

test.describe.serial('phase4 host', () => {
  test.describe.configure({ timeout: 60 * 60_000 })

  let V = ''
  let U = ''
  let tenantId = ''
  let originalQuota: Record<string, number> | null = null
  let keyId = ''
  let net6 = ''
  let netEmpty = ''
  let netDeny = ''
  let subnet = ''
  let vmA = ''
  let vmB = ''
  let vmC = ''
  let vmD = ''
  let vmGu = ''
  let lbId = ''
  let volumeId = ''
  let volSnapId = ''
  let vmSnapId = ''
  let ruleId = ''
  let refusedVmId = ''
  let vol2Id = ''
  let vol2SnapId = ''

  const readLb = () => get('tenant', `/v1/tenant/load-balancers/${lbId}`)
  const rulesOf = () => get('tenant', `/v1/tenant/networks/${net6}/firewall-rules`) as Promise<any[]>
  const readRule = async () => (await rulesOf()).find((r) => r.id === ruleId) ?? { status: 'Gone' }
  const readVmSnap = async (id: string) => ((await get('tenant', `/v1/tenant/vms/${vmA}/snapshots`)) as any[]).find((r) => r.id === id) ?? { status: 'Gone' }
  const readVolSnap = async (vol: string, id: string) => {
    const reply = await call('tenant', 'GET', `/v1/tenant/volumes/${vol}/snapshots`)
    if (reply.status === 404) {
      return { status: 'Gone' }
    }
    return (bodyOf(reply) as any[]).find((r) => r.id === id) ?? { status: 'Gone' }
  }
  const adminRow = async () => (await get('admin', '/v1/tenants') as any[]).find((t) => t.id === tenantId)

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(30 * 60_000)
    startLog('phase4-host')
    V = phase4Key('V')
    U = phase4Key('U')
    useBrowser(browser)
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    const row = await adminRow()
    expect(row, `tenant ${tenantId} in GET /v1/tenants`).toBeDefined()
    originalQuota = {
      maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxVolumes: row.maxVolumes, maxVmSnapshotsPerVm: row.maxVmSnapshotsPerVm,
      maxVolumeSnapshotsPerVolume: row.maxVolumeSnapshotsPerVolume, maxFirewallRulesPerNetwork: row.maxFirewallRulesPerNetwork,
      maxPublicIpv6: row.maxPublicIpv6, maxSshKeys: row.maxSshKeys, maxLoadBalancers: row.maxLoadBalancers,
    }
    log(`quota before: ${JSON.stringify(originalQuota)} tenant=${tenantId}`)
  })

  test.afterAll(async () => {
    test.setTimeout(40 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = [
      ['load balancer', async () => {
        if (lbId === '') {
          return
        }
        const lb = await readLb()
        if (lb.status !== 'Deleting' && lb.status !== 'Deleted') {
          await pollUntil('cleanup: lb at rest', readLb, (r) => !LB_PENDING.has(r.status), existenceShape)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
        }
        await pollUntil('cleanup: lb deleted', readLb, (r) => r.status === 'Deleted', existenceShape)
      }],
      ['firewall rule', async () => {
        if (ruleId === '' || net6 === '') {
          return
        }
        const rule = await pollUntil('cleanup: rule at rest', readRule, (r) => !RULE_PENDING.has(r.status) || r.status === 'Deleting', existenceShape)
        if (!GONE.has(rule.status) && rule.status !== 'Deleting') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${net6}/firewall-rules/${ruleId}`), 204)
        }
        await pollUntil('cleanup: rule gone', readRule, (r) => GONE.has(r.status), existenceShape)
      }],
      ['vm snapshot', async () => {
        if (vmSnapId === '' || vmA === '') {
          return
        }
        const snap = await readVmSnap(vmSnapId)
        if (!GONE.has(snap.status) && snap.status !== 'Deleting') {
          await pollUntil('cleanup: vm snapshot at rest', () => readVmSnap(vmSnapId), (r) => !SNAP_PENDING.has(r.status) || GONE.has(r.status), existenceShape)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmA}/snapshots/${vmSnapId}`), 202)
        }
        await pollUntil('cleanup: vm snapshot deleted', () => readVmSnap(vmSnapId), (r) => GONE.has(r.status), existenceShape)
      }],
    ]
    for (const id of [vmA, vmB, vmC, vmD, vmGu, refusedVmId]) {
      if (id !== '') {
        steps.push([`vm ${id}`, () => deleteVmAndWait(id)])
      }
    }
    for (const [vol, snap] of [[volumeId, () => volSnapId], [vol2Id, () => vol2SnapId]] as Array<[string, () => string]>) {
      if (vol === '') {
        continue
      }
      steps.push([`volume snapshot of ${vol}`, async () => {
        const id = snap()
        if (id === '') {
          return
        }
        const row = await readVolSnap(vol, id)
        if (!GONE.has(row.status) && row.status !== 'Deleting' && row.status !== 'NotFound') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${vol}/snapshots/${id}`), 202)
        }
        await pollUntil('cleanup: volume snapshot deleted', () => readVolSnap(vol, id), (r) => GONE.has(r.status) || r.status === 'NotFound', existenceShape)
      }])
      steps.push([`volume ${vol}`, async () => {
        const v = await readVolume(vol)
        if (v.status !== 'Deleting' && v.status !== 'Deleted') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${vol}`), 202)
        }
        await waitVolume('cleanup: volume deleted', vol, (r) => r.status === 'Deleted')
      }])
    }
    for (const id of [net6, netEmpty, netDeny]) {
      if (id !== '') {
        steps.push([`network ${id}`, async () => {
          const n = await get('tenant', `/v1/tenant/networks/${id}`)
          if (n.status !== 'Deleting' && n.status !== 'Deleted') {
            expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${id}`), 202)
          }
          await waitNetwork('cleanup: network deleted', id, (r) => r.status === 'Deleted')
        }])
      }
    }
    steps.push(['ssh key', async () => {
      if (keyId !== '') {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${keyId}`), 204)
      }
    }])
    steps.push(['quota', async () => {
      if (originalQuota !== null) {
        expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
        log(`quota restored: ${JSON.stringify(originalQuota)}`)
      }
    }])
    steps.push(['sessions', closeSessions])
    await cleanUp(steps)
  })

  test('P4-SETUP three networks, four VMs, a load balancer, a volume, snapshots, a firewall rule', async () => {
    const { clusterId, smallTier, templateId, volumeOfferingId } = await envOf()
    const counting = async (path: string) => (await get('tenant', path) as any[]).filter((r) => !OUTSIDE.has(r.status)).length
    const liveVms = await counting('/v1/tenant/vms')
    const liveNets = await counting('/v1/tenant/networks')
    const liveVols = await counting('/v1/tenant/volumes')
    const q = originalQuota!
    const raised = {
      ...q,
      maxVms: Math.max(q.maxVms, liveVms + 6),
      maxNetworks: Math.max(q.maxNetworks, liveNets + 3),
      maxVolumes: Math.max(q.maxVolumes, liveVols + 2),
      maxPublicIpv6: Math.max(q.maxPublicIpv6, liveNets + 1),
    }
    log(`live vms=${liveVms} networks=${liveNets} volumes=${liveVols}; quota ← ${JSON.stringify(raised)}`)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, raised), 204)
    const key = await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name: `rg-keyp4-${RUN}`, publicKey: V }, newKey())
    expectStatus(key, 201)
    keyId = bodyOf(key).id
    const n6 = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-net6p4-${RUN}`, clusterId, cidr: '10.77.0.0/24', enablePublicIpv6: true }, newKey())
    expectStatus(n6, 202)
    net6 = bodyOf(n6).networkId
    const ne = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-netep4-${RUN}`, clusterId, cidr: '10.78.0.0/24' }, newKey())
    expectStatus(ne, 202)
    netEmpty = bodyOf(ne).networkId
    subnet = (await waitNetwork('ipv6 network usable', net6, networkUsable)).publicIpv6Subnet
    await waitNetwork('empty network usable', netEmpty, networkUsable)
    vmA = await createVm(`rg-vmap4-${RUN}`, smallTier, net6, { userData: userDataOf('A', true, U), sshKeyIds: [keyId] })
    vmB = await createVm(`rg-vmbp4-${RUN}`, smallTier, net6, { userData: userDataOf('B', false, null) })
    vmC = await createVm(`rg-vmcp4-${RUN}`, smallTier, net6)
    vmD = await createVm(`rg-vmdp4-${RUN}`, smallTier, net6)
    for (const id of [vmA, vmB, vmC, vmD]) {
      await waitVm('vm running', id, runs)
    }
    const a = await pollUntil('vm A public ipv6', () => getVm(vmA), (v) => typeof v.publicIpv6Address === 'string', vmShape)
    const b = await pollUntil('vm B public ipv6', () => getVm(vmB), (v) => typeof v.publicIpv6Address === 'string', vmShape)
    const lb = await call('tenant', 'POST', '/v1/tenant/load-balancers', { name: `rg-lbp4-${RUN}`, networkId: net6,
      listeners: [{ protocol: 'TCP', port: 80, targetPort: 8080 }], backends: [{ vmId: vmA }, { vmId: vmB }] }, newKey())
    expectStatus(lb, 202)
    lbId = bodyOf(lb).loadBalancerId
    const lbRow = await pollUntil('lb on Incus', readLb, (r) => r.status === 'Available', existenceShape)
    const vol = await call('tenant', 'POST', '/v1/tenant/volumes', { name: `rg-volp4-${RUN}`, volumeOfferingId, clusterId, sizeGb: 10 }, newKey())
    expectStatus(vol, 202)
    volumeId = bodyOf(vol).volumeId
    await waitVolume('volume on Incus', volumeId, (v) => v.status === 'Available')
    // VOL-11 reads the snapshot's s<26> name on the host; the volume module's snapshots live shorter than a sampler cycle
    const snap = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/snapshots`, { name: `rg-vsnapp4-${RUN}` }, newKey())
    expectStatus(snap, 202)
    volSnapId = bodyOf(snap).snapshotId
    await pollUntil('volume snapshot on Incus', () => readVolSnap(volumeId, volSnapId), (r) => r.status === 'Available', existenceShape)
    // VMS-17 reads the VM snapshot's s<26> name on the host
    const vs = await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/snapshots`, { name: `rg-vmsnapp4-${RUN}` }, newKey())
    expectStatus(vs, 202)
    vmSnapId = bodyOf(vs).snapshotId
    await pollUntil('vm snapshot on Incus', () => readVmSnap(vmSnapId), (r) => r.status === 'Available', existenceShape)
    await waitVm('vm A running after its snapshot', vmA, runs)
    // FW-07 reads the rule's line in acl-<networkId>; an allow rule under the allow default changes no traffic
    const rule = await call('tenant', 'POST', `/v1/tenant/networks/${net6}/firewall-rules`,
      { direction: 'Ingress', protocol: 'TCP', startPort: 1007, endPort: 1007, cidr: '10.90.7.0/24' }, newKey())
    expectStatus(rule, 201)
    ruleId = bodyOf(rule).ruleId
    await pollUntil('rule on Incus', readRule, (r) => r.status === 'enabled', existenceShape)
    await hold('setup', {
      project: projectOf(tenantId), templateId, subnet, vip: lbRow.vip,
      net6: `net-${net6}`, netEmpty: `net-${netEmpty}`, acl: `acl-${net6}`, ruleId,
      vmA: incusName('vm', vmA), vmB: incusName('vm', vmB), vmC: incusName('vm', vmC), vmD: incusName('vm', vmD),
      volume: incusName('vol', volumeId), volumeSnapshot: incusName('s', volSnapId), vmSnapshot: incusName('s', vmSnapId),
      ipv6A: a.publicIpv6Address, ipv6B: b.publicIpv6Address, ipv4A: a.ipAddress,
    })
    // gone before OBS-04, whose delete must be refused for the attachment, not for a snapshot
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}/snapshots/${volSnapId}`), 202)
    await pollUntil('volume snapshot deleted', () => readVolSnap(volumeId, volSnapId), (r) => GONE.has(r.status), existenceShape)
    volSnapId = ''
  })

  // plan.md VM-28: a create Incus refuses through every lease ends Failed, and a DELETE then ends it at once
  // (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Creation.cs CreateFailed: no instance ⇒ Failed)
  test('VM-28 a create Incus refuses on every lease ends Failed; the name stays taken; DELETE is Deleted at once', async () => {
    const { smallTier } = await envOf()
    const name = `rg-vmgu-${RUN}`
    if (!await hold('vm28-limit', { project: projectOf(tenantId) })) {
      test.skip(true, 'host step not run')
    }
    vmGu = await createVm(name, smallTier, net6)
    const failed = await pollUntil('VM-28 create gave up', () => getVm(vmGu), (v) => v.status === 'Failed', vmShape, 10 * 60_000)
    expect(failed.requestFailureReason).toBe(VM_CREATE_FAILED)
    let actions = await activityOf(name)
    log(`VM-28 activity after the create gave up: ${actions.join(', ')}`)
    expect(actions).toEqual(['vm.create_requested'])
    await hold('vm28-unset', { project: projectOf(tenantId) })
    await sleep(150_000)
    expect((await getVm(vmGu)).status, 'Titan does not create it again').toBe('Failed')
    const { clusterId, templateId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name, networkId: net6, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()), 409, 'VM_NAME_TAKEN')
    const del = await call('tenant', 'DELETE', `/v1/tenant/vms/${vmGu}`)
    expectStatus(del, 202)
    const right = await getVm(vmGu)
    log(`VM-28 right after DELETE: ${vmShape(right)}`)
    expect(right.status).toBe('Deleted')
    actions = await activityOf(name)
    log(`VM-28 activity after DELETE: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.delete_requested')).toBe(1)
    expect(countOf(actions, 'vm.deleted')).toBe(1)
    const instance = incusName('vm', vmGu)
    vmGu = ''
    await hold('vm28-gone', { vm: instance })
  })

  // plan.md VMS-17: after the snapshot is Deleted its s<26> name is gone on the host
  test('VMS-17 the VM snapshot deleted through Titan leaves the host', async () => {
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmA}/snapshots/${vmSnapId}`), 202)
    await pollUntil('VMS-17 vm snapshot deleted', () => readVmSnap(vmSnapId), (r) => GONE.has(r.status), existenceShape)
    const name = incusName('s', vmSnapId)
    vmSnapId = ''
    await hold('vms17-gone', { vm: incusName('vm', vmA), vmSnapshot: name })
  })

  // plan.md NET-25: one Deny default ⇒ both ACL defaults drop
  test('NET-25 a deny-by-default network: both defaults drop on the host', async () => {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks',
      { name: `rg-netdeny-${RUN}`, clusterId, cidr: '10.79.0.0/24', defaultIngressPolicy: 1, defaultEgressPolicy: 0 }, newKey())
    expectStatus(reply, 202)
    netDeny = bodyOf(reply).networkId
    await waitNetwork('NET-25 usable', netDeny, networkUsable)
    await hold('net25', { network: `net-${netDeny}`, acl: `acl-${netDeny}` })
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${netDeny}`), 202)
    await waitNetwork('NET-25 deleted', netDeny, (n) => n.status === 'Deleted')
    netDeny = ''
  })

  // plan.md SSH-06: from the Internet, the key chosen at create logs in, another key does not
  test('SSH-06 ssh over public IPv6 with the chosen key', async () => {
    const a = await getVm(vmA)
    await hold('ssh06', { ipv6A: a.publicIpv6Address })
  })

  // plan.md LB-08: a stopped backend gets no traffic
  test('LB-08 with backend B stopped, only A answers', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmB}/stop`), 202)
    await waitVm('vm B stopped', vmB, (v) => v.status === 'Stopped')
    await hold('lb-one-backend', { stopped: incusName('vm', vmB) })
  })

  // plan.md VM-24: after `incus restart`, authorized_keys keeps one line per key
  test('VM-24 restart on the host', async () => {
    await hold('vm24-restart', { vm: incusName('vm', vmA) })
    await waitVm('vm A running after restart', vmA, runs)
  })

  // plan.md OBS-01: drift is observed, not corrected (titan-ops features/vm/design.md#vm-status)
  test('OBS-01 incus stop: Stopped after a reconciler cycle, nothing waiting, Titan does not start it', async () => {
    await hold('obs01', { vm: incusName('vm', vmC) })
    const vm = await waitVm('OBS-01 observed stopped', vmC, (v) => v.status === 'Stopped')
    expect(vm.requestFailureReason).toBeNull()
    await sleep(150_000)
    const later = await getVm(vmC)
    log(`OBS-01 one cycle later ${vmShape(later)}`)
    expect(later.status).toBe('Stopped')
  })

  test('OBS-02 incus start: Running', async () => {
    await hold('obs02', { vm: incusName('vm', vmC) })
    await waitVm('OBS-02 observed running', vmC, runs)
  })

  // plan.md OBS-07: Frozen, and Start unfreezes (titan-ops features/vm/design.md#requests-follow-incus)
  test('OBS-07 incus pause: Frozen; Start brings it back', async () => {
    await hold('obs07', { vm: incusName('vm', vmC) })
    await waitVm('OBS-07 observed frozen', vmC, (v) => v.status === 'Frozen')
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmC}/start`), 202)
    await waitVm('OBS-07 unfrozen', vmC, runs)
  })

  // plan.md OBS-03 (titan-ops architecture/desired-and-current.md#not-exists-convergence)
  test('OBS-03 incus delete --force: NotFound, never Deleted; a Titan delete then reaches Deleted', async () => {
    await hold('obs03', { vm: incusName('vm', vmC) })
    const vm = await waitVm('OBS-03 observed absent', vmC, (v) => v.status === 'NotFound')
    expect(vm.status).not.toBe('Deleted')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmC}`), 202)
    await waitVm('OBS-03 deleted', vmC, (v) => v.status === 'Deleted')
  })

  // plan.md OBS-04 (titan-ops features/volume/design.md#attachment-from-used-by)
  test('OBS-04 a Titan volume on an instance outside Titan: elsewhere = true; attach, detach, delete refused', async () => {
    await hold('obs04', { volume: incusName('vol', volumeId), outside: `rg-obs-${RUN}` })
    await waitVolume('OBS-04 elsewhere', volumeId, (v) => v.currentAttachedElsewhere === true)
    expectError(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/attach`, { vmId: vmA }), 422, 'VOLUME_INVALID_STATE')
    expectError(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/detach`), 422, 'VOLUME_INVALID_STATE')
    expectError(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`), 422, 'VOLUME_INVALID_STATE')
    log(`OBS-04 ${volumeShape(await readVolume(volumeId))}`)
    await hold('obs04-undo', { volume: incusName('vol', volumeId), outside: `rg-obs-${RUN}` })
    await waitVolume('OBS-04 free again', volumeId, (v) => v.currentAttachedElsewhere === false && v.currentAttachedVmId === null)
  })

  // plan.md OBS-06 (titan-ops features/network/design.md#network-reconciler)
  test('OBS-06 the empty network deleted outside Titan: NotFound', async () => {
    await hold('obs06', { network: `net-${netEmpty}` })
    await waitNetwork('OBS-06 observed absent', netEmpty, (n) => n.status === 'NotFound')
  })

  // plan.md OBS-05 (titan-ops features/catalog/design.md#template-state-is-existence)
  test('OBS-05 alias gone: NotFound in the cluster, hidden from the catalog, create is 422 TEMPLATE_UNAVAILABLE; sync brings it back', async () => {
    const { clusterId, smallTier, templateId } = await envOf()
    await hold('obs05', { alias: `tpl-${templateId}` })
    await pollUntil('OBS-05 hidden', () => get('tenant', `/v1/templates?clusterId=${clusterId}`),
      (rows: any[]) => !rows.some((t) => t.id === templateId), (rows: any[]) => rows.map((t) => t.id).join(','))
    const adminRowOf = async () => ((await get('admin', '/v1/admin/templates') as any[]).find((t) => t.id === templateId)
      ?.clusters.find((z: any) => z.clusterId === clusterId))
    const hidden = await pollUntil('OBS-05 admin row NotFound', adminRowOf, (z) => z?.status === 'NotFound', (z) => JSON.stringify(z))
    log(`OBS-05 admin row while hidden: ${JSON.stringify(hidden)}`)
    const refused = await call('tenant', 'POST', '/v1/tenant/vms',
      { name: `rg-vmrp4-${RUN}`, networkId: net6, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey())
    if (refused.status === 202) {
      refusedVmId = bodyOf(refused).vmId
    }
    expectError(refused, 422, 'TEMPLATE_UNAVAILABLE')
    expectStatus(await call('admin', 'POST', '/v1/admin/templates/sync'), 202)
    await pollUntil('OBS-05 back', () => get('tenant', `/v1/templates?clusterId=${clusterId}`),
      (rows: any[]) => rows.some((t) => t.id === templateId), (rows: any[]) => rows.map((t) => t.id).join(','), 10 * 60_000)
    const back = await pollUntil('OBS-05 admin row Available', adminRowOf, (z) => z?.status === 'Available', (z) => JSON.stringify(z))
    log(`OBS-05 template listed again; admin row ${JSON.stringify(back)}`)
    await hold('obs05-after-sync', { alias: `tpl-${templateId}` })
  })

  // plan.md OBS-08 (titan-ops architecture/resource-lifecycle.md#kinds, #callback-routes)
  test('OBS-08 a delete Incus refuses: the request ends failed, the VM stays; a new DELETE then reaches Deleted', async () => {
    await hold('obs08-protect', { vm: incusName('vm', vmD) })
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmD}`), 202)
    const failed = await pollUntil('OBS-08 request ended', () => getVm(vmD), (v) => v.status !== 'Deleting' && v.requestFailureReason !== null, vmShape, 15 * 60_000)
    expect(failed.status).not.toBe('Deleted')
    expect(failed.requestFailureReason).toBe(VM_DELETE_FAILED)
    const stopped = await waitVm('OBS-08 observed', vmD, (v) => v.status === 'Stopped')
    expect(stopped.id).toBe(vmD)
    const actions = await activityOf(`rg-vmdp4-${RUN}`)
    log(`OBS-08 activity: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.delete_failed')).toBe(1)
    await hold('obs08-unprotect', { vm: incusName('vm', vmD) })
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmD}`), 202)
    await waitVm('OBS-08 deleted', vmD, (v) => v.status === 'Deleted')
  })

  // plan.md OBS-09 (titan-ops architecture/desired-and-current.md#existence-axis, #forget-on-provider-confirm)
  test('OBS-09 a VM snapshot deleted outside Titan: NotFound, revert refused, DELETE forgets it', async () => {
    const name = `rg-vmsnap9p4-${RUN}`
    const vs = await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/snapshots`, { name }, newKey())
    expectStatus(vs, 202)
    const id = bodyOf(vs).snapshotId as string
    vmSnapId = id
    await pollUntil('OBS-09 snapshot available', () => readVmSnap(id), (r) => r.status === 'Available', existenceShape)
    await waitVm('OBS-09 vm A running', vmA, runs)
    if (!await hold('obs09', { vm: incusName('vm', vmA), snapshot: incusName('s', id) })) {
      test.skip(true, 'host step not run')
    }
    const gone = await pollUntil('OBS-09 observed absent', () => readVmSnap(id), (r) => r.status === 'NotFound', existenceShape)
    expect(gone.status).not.toBe('Deleted')
    expectError(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/snapshots/${id}/revert`), 422, 'VM_SNAPSHOT_INVALID_STATE')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmA}/snapshots/${id}`), 202)
    await pollUntil('OBS-09 forgotten', () => readVmSnap(id), (r) => r.status === 'Gone', existenceShape)
    vmSnapId = ''
    const actions = await activityOf(name)
    log(`OBS-09 activity: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm_snapshot.delete_requested')).toBe(1)
    expect(countOf(actions, 'vm_snapshot.deleted')).toBe(1)
  })

  // plan.md OBS-10 (titan-ops architecture/desired-and-current.md#existence-axis; features/volume/design.md#delete-refused-with-snapshots)
  test('OBS-10 a volume deleted outside Titan with its snapshot: both NotFound, attach refused, DELETE forgets both', async () => {
    const { clusterId, volumeOfferingId } = await envOf()
    const name = `rg-vol2p4-${RUN}`
    const vol = await call('tenant', 'POST', '/v1/tenant/volumes', { name, volumeOfferingId, clusterId, sizeGb: 10 }, newKey())
    expectStatus(vol, 202)
    vol2Id = bodyOf(vol).volumeId
    await waitVolume('OBS-10 volume available', vol2Id, (v) => v.status === 'Available')
    const snap = await call('tenant', 'POST', `/v1/tenant/volumes/${vol2Id}/snapshots`, { name: `rg-vsnap2p4-${RUN}` }, newKey())
    expectStatus(snap, 202)
    vol2SnapId = bodyOf(snap).snapshotId
    await pollUntil('OBS-10 snapshot available', () => readVolSnap(vol2Id, vol2SnapId), (r) => r.status === 'Available', existenceShape)
    if (!await hold('obs10', { volume: incusName('vol', vol2Id), snapshot: incusName('s', vol2SnapId) })) {
      test.skip(true, 'host step not run')
    }
    await waitVolume('OBS-10 volume observed absent', vol2Id, (v) => v.status === 'NotFound')
    const s = await pollUntil('OBS-10 snapshot observed absent', () => readVolSnap(vol2Id, vol2SnapId), (r) => r.status === 'NotFound', existenceShape)
    expect(s.status).not.toBe('Deleted')
    expectError(await call('tenant', 'POST', `/v1/tenant/volumes/${vol2Id}/attach`, { vmId: vmA }), 422, 'VOLUME_INVALID_STATE')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${vol2Id}`), 202)
    await pollUntil('OBS-10 volume left the list', async () => {
      const row = (await get('tenant', '/v1/tenant/volumes') as any[]).find((v) => v.id === vol2Id)
      return row ?? { status: 'Gone' }
    }, (r) => r.status === 'Gone' || r.status === 'Deleted', existenceShape)
    const after = await readVolSnap(vol2Id, vol2SnapId)
    log(`OBS-10 snapshot after: ${existenceShape(after)}`)
    expect(GONE.has(after.status), 'the snapshot left its list with the volume').toBe(true)
    vol2SnapId = ''
    vol2Id = ''
    const actions = await activityOf(name)
    log(`OBS-10 activity: ${actions.join(', ')}`)
    expect(countOf(actions, 'volume.deleted')).toBe(1)
  })

  // plan.md OBS-11 (titan-ops features/network/design.md#firewall-on-incus)
  test('OBS-11 a rule removed from the ACL outside Titan: NotFound, still listed; DELETE 204 then it leaves', async () => {
    const rule = await readRule()
    if (!await hold('obs11', { acl: `acl-${net6}`, ruleId, direction: String(rule.direction).toLowerCase() })) {
      test.skip(true, 'host step not run')
    }
    const gone = await pollUntil('OBS-11 observed absent', readRule, (r) => r.status === 'NotFound', existenceShape)
    expect(gone.status).not.toBe('Deleted')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${net6}/firewall-rules/${ruleId}`), 204)
    await pollUntil('OBS-11 left the list', readRule, (r) => r.status === 'Gone', existenceShape)
    ruleId = ''
  })

  // plan.md OBS-12 (titan-ops features/load-balancer/design.md#lb-lifecycle)
  test('OBS-12 the load balancer deleted outside Titan: NotFound, not recreated; DELETE reaches Deleted; the network goes after it', async () => {
    const lb = await readLb()
    if (!await hold('obs12', { network: `net-${net6}`, vip: lb.vip })) {
      test.skip(true, 'host step not run')
    }
    const gone = await pollUntil('OBS-12 observed absent', readLb, (r) => r.status === 'NotFound', existenceShape)
    expect(gone.status).not.toBe('Deleted')
    await sleep(150_000)
    const later = await readLb()
    log(`OBS-12 one cycle later ${existenceShape(later)}`)
    expect(later.status).toBe('NotFound')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
    await pollUntil('OBS-12 deleted', readLb, (r) => r.status === 'Deleted', existenceShape)
    const actions = await activityOf(`rg-lbp4-${RUN}`)
    log(`OBS-12 activity: ${actions.join(', ')}`)
    expect(countOf(actions, 'load_balancer.deleted')).toBe(1)
  })
})
