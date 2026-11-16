import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { cleanUp } from './clean-up'
import { bodyOf, call, expectStatus, get, log, newKey, startLog } from './api'
import { RUN, createVm, deleteVmAndWait, envOf, networkUsable, readVolume, runs, volumeShape, waitNetwork, waitVm,
  waitVolume } from './fixtures'
import { hold } from './host-hold'
import { incusName, projectOf } from './incus-names'

// plan.md BAK-18, the Phase 4 step of README.md §Phase 4 that waits for the hourly backup
// (titan-ops features/backup/design.md#incus-backup): a running VM with a volume attached; while its copy bk<26> is on the host the
// agent reads the copy's devices and the volume's used_by (`python3 phase4.py bak18`), then the API must still say the
// volume is on the VM and nowhere else. One backup per VM per day: the VM is new, so the first backup-schedule run
// after it (minute 0 UTC) backs it up. A job of its own: the wait for :00 does not fit in the runner's 90 minutes
// (activeDeadlineSeconds) after the rest of Phase 4. Within those 90: setup (about a minute on dev), the copy (up to
// 60), the uploads of the VM and the volume (up to 12), afterAll (up to 10), and the copy of the results.
const COPY_WAIT_MS = 60 * 60_000
const GONE_WAIT_MS = 12 * 60_000
// Statuses outside every quota (OpenViCloud/titan-cloud-console:portal/src/lib/quota.ts, the control plane's OccupiesQuota)
const OUTSIDE = new Set(['Deleting', 'Deleted', 'NotFound', 'Failed'])
const VOLUME_PENDING = new Set(['Creating', 'Attaching', 'Detaching', 'Deleting'])

test.describe.serial('phase4 backup copy', () => {
  test.describe.configure({ timeout: 88 * 60_000 })

  let tenantId = ''
  let originalQuota: Record<string, number> | null = null
  let networkId = ''
  let vmId = ''
  let volumeId = ''

  const adminRow = async () => (await get('admin', '/v1/tenants') as any[]).find((t) => t.id === tenantId)

  test.beforeAll(async ({ browser }) => {
    startLog('phase4-backup')
    useBrowser(browser)
    tenantId = (await get('tenant', '/v1/tenant')).id
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
    test.setTimeout(10 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = []
    if (volumeId !== '') {
      steps.push(['detach', async () => {
        const v = await waitVolume('cleanup: volume at rest', volumeId, (r) => !VOLUME_PENDING.has(r.status))
        if (v.currentAttachedVmId !== null && v.status !== 'Deleted') {
          expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/detach`), 202)
          await waitVolume('cleanup: detached', volumeId, (r) => r.currentAttachedVmId === null && !VOLUME_PENDING.has(r.status))
        }
      }])
    }
    if (vmId !== '') {
      steps.push([`vm ${vmId}`, () => deleteVmAndWait(vmId)])
    }
    if (volumeId !== '') {
      steps.push([`volume ${volumeId}`, async () => {
        const v = await readVolume(volumeId)
        if (v.status !== 'Deleting' && v.status !== 'Deleted') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`), 202)
        }
        await waitVolume('cleanup: volume deleted', volumeId, (r) => r.status === 'Deleted')
      }])
    }
    if (networkId !== '') {
      steps.push([`network ${networkId}`, async () => {
        const n = await get('tenant', `/v1/tenant/networks/${networkId}`)
        if (n.status !== 'Deleting' && n.status !== 'Deleted') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}`), 202)
        }
        await waitNetwork('cleanup: network deleted', networkId, (r) => r.status === 'Deleted')
      }])
    }
    steps.push(['quota', async () => {
      if (originalQuota !== null) {
        expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
        log(`quota restored: ${JSON.stringify(originalQuota)}`)
      }
    }])
    steps.push(['sessions', closeSessions])
    await cleanUp(steps)
  })

  test('BAK-18 the backup copy of a VM leaves its volume out: used_by and the API keep the volume on the VM', async () => {
    const { clusterId, smallTier, volumeOfferingId } = await envOf()
    const counting = async (path: string) => (await get('tenant', path) as any[]).filter((r) => !OUTSIDE.has(r.status)).length
    const q = originalQuota!
    const raised = {
      ...q,
      maxVms: Math.max(q.maxVms, await counting('/v1/tenant/vms') + 1),
      maxNetworks: Math.max(q.maxNetworks, await counting('/v1/tenant/networks') + 1),
      maxVolumes: Math.max(q.maxVolumes, await counting('/v1/tenant/volumes') + 1),
    }
    log(`quota ← ${JSON.stringify(raised)}`)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, raised), 204)
    const net = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-netbkp4-${RUN}`, clusterId, cidr: '10.79.0.0/24' }, newKey())
    expectStatus(net, 202)
    networkId = bodyOf(net).networkId
    await waitNetwork('network usable', networkId, networkUsable)
    vmId = await createVm(`rg-vmbkp4-${RUN}`, smallTier, networkId)
    await waitVm('vm running', vmId, runs)
    const vol = await call('tenant', 'POST', '/v1/tenant/volumes', { name: `rg-volbkp4-${RUN}`, volumeOfferingId, clusterId, sizeGb: 10 }, newKey())
    expectStatus(vol, 202)
    volumeId = bodyOf(vol).volumeId
    await waitVolume('volume on Incus', volumeId, (v) => v.status === 'Available')
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/attach`, { vmId }), 202)
    await waitVolume('volume attached', volumeId, (v) => v.currentAttachedVmId === vmId && !VOLUME_PENDING.has(v.status))
    const covered = await hold('bak18', { project: projectOf(tenantId), vm: incusName('vm', vmId),
      copy: incusName('bk', vmId), volume: incusName('vol', volumeId) }, COPY_WAIT_MS)
    try {
      test.skip(!covered, 'NOT COVERED: no copy caught, or no reconcile while it existed (phase4.py bak18)')
      const after = await readVolume(volumeId)
      log(`BAK-18 ${volumeShape(after)}`)
      expect(after.currentAttachedVmId).toBe(vmId)
      expect(after.currentAttachedElsewhere).toBe(false)
    } finally {
      // The VM's copy keeps a NIC on this network until its upload ends (a network delete fails before that), and the
      // same run then copies the volume (a detach meanwhile times out): clean up after both copies are gone
      await hold('bak18-gone', { project: projectOf(tenantId), copy: incusName('bk', vmId),
        volumeCopy: incusName('bkv', volumeId) }, GONE_WAIT_MS)
    }
  })
})
