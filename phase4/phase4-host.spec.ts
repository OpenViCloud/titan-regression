import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { closeSessions, useBrowser } from './auth'
import { cleanUp } from './clean-up'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, existenceShape, getVm, networkUsable, readVolume,
  runs, vmShape, volumeShape, waitNetwork, waitVm, waitVolume } from './fixtures'
import { HOLD_MS, hold } from './host-hold'
import { incusName, phase4Key, projectOf } from './incus-names'

// Phase 4 of the release run (`release:regression-prd`; README.md §Phase 4): resources that the
// agent's commands on the Incus host and from the Internet act on. At each HOLD (lib/host-hold.ts) the spec logs what it
// holds and waits for go-<step> or skip-<step>; then it reads the API for the expectation of plan.md, and a test whose
// first step writes on the host (WRITES of phase4_steps.py) and is answered skip is reported skipped, never passed on
// what the host did not do. Everything it
// creates is deleted in afterAll, every step even when one fails (cleanUp); the caps it raises are given back.
// V is stored as the tenant's SSH key, U goes in vm A's cloud-init; the agent keeps the private halves and a third key X
// that Titan never sees (python3 phase4.py keys).
// OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/VmReports.cs (FixedFailureReason)
const VM_DELETE_FAILED = 'The VM could not be deleted. Please try again or contact support.'
const VM_CREATE_FAILED = 'VM provisioning failed due to a system error. Please try again or contact support.'
// Statuses outside every quota (OpenViCloud/titan-cloud-console:portal/src/lib/quota.ts, the control plane's OccupiesQuota);
// a VM or volume restored from a backup is outside too: this module makes none, and one left on the tenant by
// another case is counted here, which only raises the caps the module sets
const OUTSIDE = new Set(['Deleting', 'Deleted', 'NotFound', 'Failed'])
// Statuses that wait on a command of their own, per resource (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/*/Enums/*Status.cs at 8fd95ac)
const LB_PENDING = new Set(['Creating', 'Updating', 'Deleting'])
const RULE_PENDING = new Set(['Creating', 'Deleting'])
const SNAP_PENDING = new Set(['Creating', 'Reverting', 'Deleting'])
const GONE = new Set(['Gone', 'Deleted'])
// VM-35's console password, for `python3 phase4.py vm35` to hash and grep for inside this pod (phase4.py cmd_vm35):
// outside RESULTS, which run-module.sh copies out, so it never leaves the pod; removed after the hold and in afterAll.
const VM35_HAND_OFF = '/work/vm-35'

// 12 characters, from letters that need no quoting in a shell or a cloud-init script
function passwordOf(length: number): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(length)
  let password = ''
  for (let i = 0; i < length; i++) {
    password += letters[bytes[i] % letters.length]
  }
  return password
}

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

// A loop that appends one line every 15 s to log: `<UTC time> <check>=ok|fail … <nc's own words>`, so that a tail of it
// on the host says whether the VM's packets went out and their answers came back. Only the checks change per VM.
function loopUserData(log: string, checks: string[]): string {
  const script = [
    '#!/bin/sh',
    'set -f',
    'while true; do',
    ...checks.map((c) => `  ${c}`),
    '  sleep 15',
    'done',
  ]
  return ['#cloud-config', 'write_files:', '  - path: /usr/local/bin/rg-loop', "    permissions: '0755'", '    content: |',
    ...script.map((l) => `      ${l}`),
    'runcmd:', `  - [sh, -c, "nohup /usr/local/bin/rg-loop >>${log} 2>&1 &"]`].join('\n') + '\n'
}

// FW-08's vm A and vm B: ping and TCP 22 to the host on the uplink (nc -z sends no data)
function outboundUserData(host: string): string {
  return loopUserData('/var/log/rg-out.log', [
    `if ping -6 -c1 -W3 ${host} >/dev/null 2>&1; then p=ok; else p=fail; fi`,
    `n=$(nc -6 -zv -w5 ${host} 22 2>&1); if [ $? = 0 ]; then t=ok; else t=fail; fi`,
    `printf '%s ping6=%s tcp22=%s %s\\n' "$(date -u +%FT%TZ)" "$p" "$t" "$(echo $n)"`,
  ])
}

// FW-08's vm B2: ping to vm B's IPv4 on their network
function eastUserData(ipv4: string): string {
  return loopUserData('/var/log/rg-east.log', [
    `if ping -c1 -W3 ${ipv4} >/dev/null 2>&1; then p=ok; else p=fail; fi`,
    `printf '%s ping4=%s\\n' "$(date -u +%FT%TZ)" "$p"`,
  ])
}

// The uplink's gateway, ::1 of the first /64 of the cluster's /56 (written as its first address): OVH's router on
// singapore01 (titan-ops infra/incus/design.md#ipv6-address-plan), the titan-incus host on dev
// (OpenViCloud/titan-local-cluster:docs/network.md, `ovnup`)
function gatewayOf(block: string): string {
  const address = block.split('/')[0]
  const [head, tail] = address.includes('::') ? address.split('::') : [address, '']
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' ? [] : tail.split(':')
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map((g) => parseInt(g, 16))
  groups[7] += 1
  return groups.map((g) => g.toString(16)).join(':')
}

// Where the checks "from outside the network" run (plan.md FW-08, LB-18): the runner's pod has no IPv6 route out
const FROM_OUTSIDE = 'dev: on titan-incus (phase4.py step --env dev, or host); release env: this machine (phase4.py step, or host --local; over the Internet, this machine without IPv6 => N/A)'

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
  let vmPw = ''
  let lbId = ''
  let volumeId = ''
  let volSnapId = ''
  let vmSnapId = ''
  let ruleId = ''
  let refusedVmId = ''
  let vol2Id = ''
  let vol2SnapId = ''
  // What FW-08 and LB-18 made and have not yet seen deleted: their finally deletes it, afterAll whatever that left
  const extraRules: Array<{ network: string, rule: string }> = []
  const extraLbs: string[] = []
  const extraVms: string[] = []
  const extraNets: string[] = []

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
  const liveOf = async (path: string) => (await get('tenant', path) as any[]).filter((r) => !OUTSIDE.has(r.status))
  const clusterOf = async () => {
    const { clusterId } = await envOf()
    const settings = (await get('admin', '/v1/admin/clusters') as any[]).find((c) => c.clusterId === clusterId)?.providerSettings
    return { block: (settings?.ipv6Block ?? null) as string | null, uplink: (settings?.ovnUplinkNetwork ?? null) as string | null }
  }

  // A rule of its own, 201 {ruleId}, then enabled (plan.md FW-01)
  async function addRule(network: string, rule: Record<string, unknown>): Promise<string> {
    const made = await call('tenant', 'POST', `/v1/tenant/networks/${network}/firewall-rules`, rule, newKey())
    expectStatus(made, 201)
    const id = bodyOf(made).ruleId as string
    extraRules.push({ network, rule: id })
    const read = async () => ((await get('tenant', `/v1/tenant/networks/${network}/firewall-rules`)) as any[]).find((r) => r.id === id) ?? { status: 'Gone' }
    await pollUntil(`rule ${id} enabled`, read, (r) => r.status === 'enabled', existenceShape)
    return id
  }

  // An IPv6 network of its own, Created; policies only when given
  async function addNetwork(name: string, cidr: string, policies: Record<string, number> = {}): Promise<any> {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name, clusterId, cidr, enablePublicIpv6: true, ...policies }, newKey())
    expectStatus(reply, 202)
    const id = bodyOf(reply).networkId as string
    extraNets.push(id)
    return waitNetwork(`network ${name} usable`, id, networkUsable)
  }

  // Raises the caps FW-08 or LB-18 needs above what the tenant holds now; returns the quota to give back
  async function raiseFor(more: { vms: number, networks: number, lbs: number }): Promise<Record<string, number>> {
    const row = await adminRow()
    const before = { maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxPublicIpv6: row.maxPublicIpv6, maxLoadBalancers: row.maxLoadBalancers }
    const nets = await liveOf('/v1/tenant/networks')
    const vms = (await liveOf('/v1/tenant/vms')).length
    const lbs = (await liveOf('/v1/tenant/load-balancers')).length
    const v6 = nets.filter((n) => n.publicIpv6Subnet !== null).length
    const raised = {
      maxVms: Math.max(before.maxVms, vms + more.vms),
      maxNetworks: Math.max(before.maxNetworks, nets.length) + more.networks,
      maxPublicIpv6: Math.max(before.maxPublicIpv6, v6 + more.networks),
      maxLoadBalancers: Math.max(before.maxLoadBalancers, lbs + more.lbs),
    }
    log(`live vms=${vms} networks=${nets.length} ipv6=${v6} lbs=${lbs}; quota ← ${JSON.stringify(raised)}`)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, raised), 204)
    return before
  }

  // Rules, then load balancers (a backend VM and its network refuse a delete while one asks for them), VMs, networks;
  // every one gets its turn, and leaves its list only once deleted
  async function dropExtras(quota: Record<string, number> | null): Promise<void> {
    const forget = <T>(list: T[], item: T) => {
      list.splice(list.indexOf(item), 1)
    }
    const steps: Array<[string, () => Promise<void>]> = []
    for (const r of [...extraRules]) {
      steps.push([`rule ${r.rule}`, async () => {
        const read = async () => ((await get('tenant', `/v1/tenant/networks/${r.network}/firewall-rules`)) as any[]).find((x) => x.id === r.rule) ?? { status: 'Gone' }
        const rule = await pollUntil('cleanup: rule at rest', read, (x) => !RULE_PENDING.has(x.status) || x.status === 'Deleting', existenceShape)
        if (!GONE.has(rule.status) && rule.status !== 'Deleting') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${r.network}/firewall-rules/${r.rule}`), 204)
        }
        await pollUntil('cleanup: rule gone', read, (x) => GONE.has(x.status), existenceShape)
        forget(extraRules, r)
      }])
    }
    for (const id of [...extraLbs]) {
      steps.push([`load balancer ${id}`, async () => {
        const read = () => get('tenant', `/v1/tenant/load-balancers/${id}`)
        const lb = await read()
        if (lb.status !== 'Deleting' && lb.status !== 'Deleted') {
          await pollUntil('cleanup: lb at rest', read, (x) => !LB_PENDING.has(x.status), existenceShape)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${id}`), 202)
        }
        await pollUntil('cleanup: lb deleted', read, (x) => x.status === 'Deleted', existenceShape)
        forget(extraLbs, id)
      }])
    }
    for (const id of [...extraVms]) {
      steps.push([`vm ${id}`, async () => {
        await deleteVmAndWait(id)
        forget(extraVms, id)
      }])
    }
    for (const id of [...extraNets]) {
      steps.push([`network ${id}`, async () => {
        const n = await get('tenant', `/v1/tenant/networks/${id}`)
        if (n.status !== 'Deleting' && n.status !== 'Deleted') {
          await waitNetwork('cleanup: network at rest', id, (x) => x.status !== 'Creating')
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${id}`), 202)
        }
        await waitNetwork('cleanup: network deleted', id, (x) => x.status === 'Deleted')
        forget(extraNets, id)
      }])
    }
    if (quota !== null) {
      steps.push(['quota', async () => {
        expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, quota), 204)
        log(`quota given back: ${JSON.stringify(quota)}`)
      }])
    }
    await cleanUp(steps)
  }

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
      ['vm-35 hand-off', async () => {
        fs.rmSync(VM35_HAND_OFF, { recursive: true, force: true })
      }],
      ['FW-08 and LB-18 leftovers', () => dropExtras(null)],
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
    for (const id of [vmA, vmB, vmC, vmD, vmGu, vmPw, refusedVmId]) {
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
      maxVms: Math.max(q.maxVms, liveVms + 7),
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
    // A new network drops what comes from outside it: VM-14 (ping), SSH-06 (TCP 22) and LB-08 (the target port) open
    // their port the way a customer does (plan.md VM-14, SSH-06, LB-08)
    const rules = [
      { direction: 'Ingress', protocol: 'ICMP', cidr: '::/0' },
      { direction: 'Ingress', protocol: 'TCP', startPort: 22, endPort: 22, cidr: '::/0' },
      { direction: 'Ingress', protocol: 'TCP', startPort: 8080, endPort: 8080, cidr: '::/0' },
    ]
    const ruleIds: string[] = []
    for (const rule of rules) {
      const made = await call('tenant', 'POST', `/v1/tenant/networks/${net6}/firewall-rules`, rule, newKey())
      expectStatus(made, 201)
      ruleIds.push(bodyOf(made).ruleId)
    }
    await pollUntil('rules of the ipv6 network enabled', () => get('tenant', `/v1/tenant/networks/${net6}/firewall-rules`),
      (rows: any[]) => ruleIds.every((id) => rows.some((r) => r.id === id && r.status === 'enabled')),
      (rows: any[]) => JSON.stringify(rows.map((r) => r.status)))
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
    // FW-07 reads the rule's line in acl-<networkId>; it allows a port nothing listens on, from a range no client uses
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

  // plan.md VM-35 (titan-ops features/vm/design.md#console-password): the console password reaches the guest as its
  // SHA-512 crypt hash only. OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/VmVendorData.cs
  // (AppendPassword: a once-per-instance script that cloud-init's final stage runs, `chpasswd -e` with the hash) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/Sha512Crypt.cs (Hash: a random salt of 16).
  // The agent's `python3 phase4.py vm35` waits for cloud-init in the guest, reads the shadow, `passwd -S` and the
  // vendor-data of this VM and of vm A (keys, no password), and hashes the password with the salt it read and greps the
  // vendor-data for it inside this pod (phase4.py vm35_verdict): the host reads are its verdict. On net6 (netEmpty
  // must stay empty for OBS-06), before VM-28 puts its limit on the project.
  test('VM-35 a console password is a $6$ hash in /etc/shadow and in vendor-data, never the password; a VM without one is locked', async () => {
    test.setTimeout(HOLD_MS + 20 * 60_000)
    const { smallTier } = await envOf()
    const password = passwordOf(12)
    vmPw = await createVm(`rg-vmpw4-${RUN}`, smallTier, net6, { consolePassword: password })
    await waitVm('VM-35 vm running', vmPw, runs)
    fs.rmSync(VM35_HAND_OFF, { recursive: true, force: true })
    fs.mkdirSync(VM35_HAND_OFF, { mode: 0o700 })
    fs.writeFileSync(`${VM35_HAND_OFF}/password`, password, { mode: 0o600 })
    const go = await hold('vm35', { project: projectOf(tenantId), vm: incusName('vm', vmPw), vmWithout: incusName('vm', vmA),
      passwordFile: `${VM35_HAND_OFF}/password` })
    fs.rmSync(VM35_HAND_OFF, { recursive: true, force: true })
    test.skip(!go, 'host step not run')
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

  // plan.md NET-25: each policy sets its own direction — Allow in, Deny out ⇒ ingress allow, egress drop
  test('NET-25 a network that denies outbound: only the egress default drops on the host', async () => {
    const { clusterId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/networks',
      { name: `rg-netdeny-${RUN}`, clusterId, cidr: '10.79.0.0/24', defaultIngressPolicy: 0, defaultEgressPolicy: 1 }, newKey())
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
    if (!await hold('vm24-restart', { vm: incusName('vm', vmA) })) {
      test.skip(true, 'host step not run')
    }
    await waitVm('vm A running after restart', vmA, runs)
  })

  // plan.md OBS-01: drift is observed, not corrected (titan-ops features/vm/design.md#vm-status)
  test('OBS-01 incus stop: Stopped after a reconciler cycle, nothing waiting, Titan does not start it', async () => {
    if (!await hold('obs01', { vm: incusName('vm', vmC) })) {
      test.skip(true, 'host step not run')
    }
    const vm = await waitVm('OBS-01 observed stopped', vmC, (v) => v.status === 'Stopped')
    expect(vm.requestFailureReason).toBeNull()
    await sleep(150_000)
    const later = await getVm(vmC)
    log(`OBS-01 one cycle later ${vmShape(later)}`)
    expect(later.status).toBe('Stopped')
  })

  test('OBS-02 incus start: Running', async () => {
    if (!await hold('obs02', { vm: incusName('vm', vmC) })) {
      test.skip(true, 'host step not run')
    }
    await waitVm('OBS-02 observed running', vmC, runs)
  })

  // plan.md OBS-07: Frozen, and Start unfreezes (titan-ops features/vm/design.md#requests-follow-incus)
  test('OBS-07 incus pause: Frozen; Start brings it back', async () => {
    if (!await hold('obs07', { vm: incusName('vm', vmC) })) {
      test.skip(true, 'host step not run')
    }
    await waitVm('OBS-07 observed frozen', vmC, (v) => v.status === 'Frozen')
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmC}/start`), 202)
    await waitVm('OBS-07 unfrozen', vmC, runs)
  })

  // plan.md OBS-03 (titan-ops architecture/desired-and-current.md#not-exists-convergence)
  test('OBS-03 incus delete --force: NotFound, never Deleted; a Titan delete then reaches Deleted', async () => {
    if (!await hold('obs03', { vm: incusName('vm', vmC) })) {
      test.skip(true, 'host step not run')
    }
    const vm = await waitVm('OBS-03 observed absent', vmC, (v) => v.status === 'NotFound')
    expect(vm.status).not.toBe('Deleted')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmC}`), 202)
    await waitVm('OBS-03 deleted', vmC, (v) => v.status === 'Deleted')
  })

  // plan.md OBS-04 (titan-ops features/volume/design.md#attachment-from-used-by)
  test('OBS-04 a Titan volume on an instance outside Titan: elsewhere = true; attach, detach, delete refused', async () => {
    if (!await hold('obs04', { volume: incusName('vol', volumeId), outside: `rg-obs-${RUN}` })) {
      test.skip(true, 'host step not run')
    }
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
    if (!await hold('obs06', { network: `net-${netEmpty}` })) {
      test.skip(true, 'host step not run')
    }
    await waitNetwork('OBS-06 observed absent', netEmpty, (n) => n.status === 'NotFound')
  })

  // plan.md OBS-05 (titan-ops features/catalog/design.md#template-state-is-existence)
  test('OBS-05 alias gone: NotFound in the cluster, hidden from the catalog, create is 422 TEMPLATE_UNAVAILABLE; sync brings it back', async () => {
    const { clusterId, smallTier, templateId } = await envOf()
    if (!await hold('obs05', { alias: `tpl-${templateId}` })) {
      test.skip(true, 'host step not run')
    }
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
    if (!await hold('obs08-protect', { vm: incusName('vm', vmD) })) {
      test.skip(true, 'host step not run')
    }
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

  // plan.md FW-08 (titan-ops features/network/design.md#firewall-default-policy · titan-ops features/network/design.md#ipv6-public;
  // OpenViCloud/titan-incus-worker:resource/network/create.go DefaultAction, defaultActionsOf): a network made without
  // policies drops what comes from outside it and lets its VMs out, and VMs of one network still reach each other; a
  // network sent Allow/Allow lets both through. The spec checks the policies the API reads back; the measured parts
  // are the agent's commands at fw08-before and fw08-after-rule, from outside the network and in-guest log reads.
  test('FW-08 a network made without policies: Deny in, Allow out; a TCP 22 rule opens 22 only; VMs of one network reach each other', async () => {
    test.setTimeout(2 * HOLD_MS + 40 * 60_000)
    const { block, uplink } = await clusterOf()
    log(`FW-08 ipv6Block=${block} uplink=${uplink}`)
    test.skip(!block, 'the cluster has no IPv6 block')
    const { smallTier } = await envOf()
    const gateway = gatewayOf(block!)
    const project = projectOf(tenantId)
    let quota: Record<string, number> | null = null
    try {
      quota = await raiseFor({ vms: 3, networks: 2, lbs: 0 })
      const netA = await addNetwork(`rg-netfwa-${RUN}`, '10.81.0.0/24', { defaultIngressPolicy: 0, defaultEgressPolicy: 0 })
      const netB = await addNetwork(`rg-netfwb-${RUN}`, '10.82.0.0/24')
      log(`FW-08 A ingress=${netA.defaultIngressPolicy} egress=${netA.defaultEgressPolicy}; B ingress=${netB.defaultIngressPolicy} egress=${netB.defaultEgressPolicy}`)
      expect([netA.defaultIngressPolicy, netA.defaultEgressPolicy]).toEqual(['Allow', 'Allow'])
      expect([netB.defaultIngressPolicy, netB.defaultEgressPolicy]).toEqual(['Deny', 'Allow'])
      const vmFa = await createVm(`rg-vmfwa-${RUN}`, smallTier, netA.id, { userData: outboundUserData(gateway) })
      extraVms.push(vmFa)
      const vmFb = await createVm(`rg-vmfwb-${RUN}`, smallTier, netB.id, { userData: outboundUserData(gateway) })
      extraVms.push(vmFb)
      const b = await waitVm('FW-08 vm B running with its IPv4', vmFb, (v) => runs(v) && typeof v.ipAddress === 'string')
      const vmFb2 = await createVm(`rg-vmfwb2-${RUN}`, smallTier, netB.id, { userData: eastUserData(b.ipAddress) })
      extraVms.push(vmFb2)
      await waitVm('FW-08 vm A running', vmFa, runs)
      await waitVm('FW-08 vm B2 running', vmFb2, runs)
      const ipv6A = (await pollUntil('FW-08 vm A public ipv6', () => getVm(vmFa), (v) => typeof v.publicIpv6Address === 'string', vmShape)).publicIpv6Address
      const ipv6B = (await pollUntil('FW-08 vm B public ipv6', () => getVm(vmFb), (v) => typeof v.publicIpv6Address === 'string', vmShape)).publicIpv6Address
      // a few lines of each loop before the hold (cloud-init's runcmd starts it after boot)
      await sleep(90_000)
      const [vmA8, vmB8, vmB28] = [incusName('vm', vmFa), incusName('vm', vmFb), incusName('vm', vmFb2)]
      const outside = (ip: string) => [`ping -6 -c3 ${ip}`, `nc -6 -vz -w 5 ${ip} 22`, `nc -6 -vz -w 5 ${ip} 80`]
      const tail = (vm: string, file: string) => `incus exec ${vm} --project ${project} -- tail -n 8 ${file}`
      // B out to a host that listens on 22: VM A (Allow/Allow, sshd). On the release environment the uplink gateway
      // that the loops target does not answer on 22, so their tcp22 says nothing about B's egress there.
      const bToA = `incus exec ${vmB8} --project ${project} -- sh -c 'nc -6 -z -w 5 ${ipv6A} 22; echo bToA22=$?'`
      const go = await hold('fw08-before', {
        project, networkA: `net-${netA.id}`, networkB: `net-${netB.id}`, vmA: vmA8, vmB: vmB8, vmB2: vmB28,
        ipv6A, ipv6B, ipv4B: b.ipAddress, uplink, uplinkGateway: gateway,
        devPrecondition: 'dev only, on the host: ip -6 addr show ovnbr; uplinkGateway absent => FW-08 INCONCLUSIVE',
        uplinkCheck: `on the host: incus network get ${uplink} ipv6.gateway (should be uplinkGateway/64: the guests' loops target it)`,
        fromOutside: FROM_OUTSIDE,
        outside: [...outside(ipv6A), ...outside(ipv6B)],
        host: [tail(vmA8, '/var/log/rg-out.log'), tail(vmB8, '/var/log/rg-out.log'), tail(vmB28, '/var/log/rg-east.log'), bToA],
        expect: 'A: ping 3 received, 22 succeeded, 80 refused; B: ping 100% loss, 22 and 80 timed out; '
          + 'rg-out.log of A and B: ping6=ok (tcp22=ok on dev only); rg-east.log of B2: ping4=ok; bToA22=0',
      })
      if (!go) {
        test.skip(true, 'host step not run')
      }
      const rule = await addRule(netB.id, { direction: 'Ingress', protocol: 'TCP', startPort: 22, endPort: 22, cidr: '::/0' })
      // lines of vm B's loop written after the rule is enabled
      await sleep(45_000)
      await hold('fw08-after-rule', {
        project, acl: `acl-${netB.id}`, ruleId: rule, rule: 'Ingress TCP 22 ::/0 on network B, enabled', vmB: vmB8, vmB2: vmB28, ipv6B,
        fromOutside: FROM_OUTSIDE,
        outside: outside(ipv6B),
        host: [tail(vmB8, '/var/log/rg-out.log'), tail(vmB28, '/var/log/rg-east.log'), bToA],
        expect: 'B: 22 succeeded; ping 100% loss, 80 timed out; rg-out.log of B: lines after the rule still ping6=ok '
          + '(tcp22=ok on dev only); rg-east.log of B2: ping4=ok; bToA22=0',
      })
    } finally {
      await dropExtras(quota)
    }
  })

  // plan.md LB-18 (titan-ops features/load-balancer/design.md#lb-and-vm-network;
  // titan-ops features/network/design.md#firewall-default-policy): the network's ACL sees a packet after the load
  // balancer changed its destination, so on a network made without policies the VIP answers only once a rule lets the
  // target port in. The measured parts are the agent's commands at lb18-before and lb18-after-rule.
  test('LB-18 a network made without policies: the VIP is silent until an Ingress TCP 8080 rule, then the backend answers', async () => {
    test.setTimeout(2 * HOLD_MS + 30 * 60_000)
    const { block } = await clusterOf()
    log(`LB-18 ipv6Block=${block}`)
    test.skip(!block, 'the cluster has no IPv6 block')
    const { smallTier } = await envOf()
    const project = projectOf(tenantId)
    let quota: Record<string, number> | null = null
    try {
      quota = await raiseFor({ vms: 1, networks: 1, lbs: 1 })
      const net = await addNetwork(`rg-netlb18-${RUN}`, '10.83.0.0/24')
      log(`LB-18 network ingress=${net.defaultIngressPolicy} egress=${net.defaultEgressPolicy}`)
      expect([net.defaultIngressPolicy, net.defaultEgressPolicy]).toEqual(['Deny', 'Allow'])
      const vm = await createVm(`rg-vmlb18-${RUN}`, smallTier, net.id, { userData: userDataOf('L18', false, null) })
      extraVms.push(vm)
      await waitVm('LB-18 backend running', vm, runs)
      const backend = await pollUntil('LB-18 backend public ipv6', () => getVm(vm), (v) => typeof v.publicIpv6Address === 'string', vmShape)
      const made = await call('tenant', 'POST', '/v1/tenant/load-balancers', { name: `rg-lb18-${RUN}`, networkId: net.id,
        listeners: [{ protocol: 'TCP', port: 80, targetPort: 8080 }], backends: [{ vmId: vm }] }, newKey())
      expectStatus(made, 202)
      const lb18 = bodyOf(made).loadBalancerId as string
      extraLbs.push(lb18)
      const lb = await pollUntil('LB-18 lb on Incus', () => get('tenant', `/v1/tenant/load-balancers/${lb18}`), (r) => r.status === 'Available', existenceShape)
      // the backend's http.server up (cloud-init's runcmd) and a round of the load balancer's health check
      await sleep(60_000)
      const backend18 = incusName('vm', vm)
      const curl = `curl -6 -g -sS -m 10 http://[${lb.vip}]:80/`
      const go = await hold('lb18-before', {
        project, network: `net-${net.id}`, acl: `acl-${net.id}`, vip: lb.vip, listener: 'TCP 80 -> 8080',
        backend: backend18, backendIpv6: backend.publicIpv6Address,
        fromOutside: FROM_OUTSIDE,
        outside: [curl],
        host: [`incus exec ${backend18} --project ${project} -- ss -ltn`],
        expect: 'curl: (28) timed out, exit=28 (no answer, not a refusal); ss: a LISTEN line on :8080 (the backend serves; only the ACL drops)',
      })
      if (!go) {
        test.skip(true, 'host step not run')
      }
      const rule = await addRule(net.id, { direction: 'Ingress', protocol: 'TCP', startPort: 8080, endPort: 8080, cidr: '::/0' })
      // a round of the health check after the rule
      await sleep(30_000)
      await hold('lb18-after-rule', {
        project, acl: `acl-${net.id}`, ruleId: rule, rule: 'Ingress TCP 8080 ::/0, enabled', vip: lb.vip,
        fromOutside: FROM_OUTSIDE,
        outside: [curl],
        expect: 'curl prints backend-L18 (the backend\'s page on 8080), exit=0',
      })
    } finally {
      await dropExtras(quota)
    }
  })
})
