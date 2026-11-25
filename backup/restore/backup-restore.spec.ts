import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { ADMIN, PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { OBSERVED_WITHIN_MS, RESULTS, bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { cleanUp } from './clean-up'
import { hold } from './host-hold'
import { incusName, projectOf } from './incus-names'
import { RUN, createVm, envOf, getVm, readVolume, runNetwork, runs, vmShape, volumeShape, waitVm, waitVolume } from './fixtures'

// Cases BAK-28, BAK-29, BAK-31…BAK-36, BAK-38 and BAK-39 of plan.md (L-x; on prd only until
// titan-ops status/known-state.md#first-real-customer): an admin's restore of a VM and of a volume from a backup as new
// resources of the tenant. A job of its own (run-module.sh … backup/restore …, job regression-restore-<label>), like
// backup/command-wait: the backup module's ConfigMap takes only the files of backup/, and the sequential lane never
// waits on the agent's steps. The job makes a VM rg-rs-vm-* with a 1 GiB volume rg-rs-data-* attached, then holds:
//   HOLD bak28        `phase4.py bak28`: a Job from CronJob control-plane-job-backup-schedule when today's backup rows of
//                     the two are not there yet, go-bak28 once both are Done (psql SELECT on core.provider_commands);
//   HOLD bak30-before `phase4.py host` (volatile.eth0.hwaddr of the source VM) then `phase4.py go` — BAK-30 is the
//   HOLD bak30-after  agent's (host); the spec goes on without an answer after HOST_HOLD_MS;
//   HOLD bak36        `phase4.py bak36`: the Job again for the restored VM and volumes (BAK-36), and BAK-31's read of
//                     core.usage_records after a pass of CronJob control-plane-job-meter; its L_BAK31= and L_BAK36= lines
//                     are those cases' verdicts, the test's ✓ only says the hold was answered.
// The order is the rows': BAK-32 during BAK-28 (before its 202, and its list read right after it), BAK-29 after
// BAK-28, BAK-38 after BAK-29 and before BAK-36 (once BAK-36's Job gave the copy's volumes an archive, its restore would
// be 202). BAK-39 sets the tenant's VM and volume caps to what it holds before BAK-28, so the two restores are asked at
// the caps, and gives them back after BAK-29, before BAK-38 makes a volume of its own. afterAll gives the caps back
// too, then deletes every rg-rs-* VM and volume of beta-user, the restores too: a restore is backed up daily.

// The runner's job ends after 90 minutes (OpenViCloud/titan-local-cluster:base/regression-runner/cronjob.yaml
// activeDeadlineSeconds 5400), the results copied before that: every wait is cut to what is left of 70 minutes from the
// spec's start, afterAll has 15, which leaves 5 for npm and the copy. A wait the budget cut short is NOT COVERED, not red.
const STARTED = Date.now()
const WORK_ENDS_AT = STARTED + 70 * 60_000
// The Job's pass, then the tenant's backups one at a time (titan-ops features/provider/design.md#tenant-lane);
// `phase4.py bak28|bak36 --backup-minutes` is 25.
const HOLD_BACKUPS_MS = 30 * 60_000
// CronJob control-plane-job-backup-status runs every 5 minutes (OpenViCloud/titan-local-cluster:base/control-plane/scheduled-jobs.yaml):
// two of its passes and the pass itself, as BAK-22.
const ARCHIVES_WITHIN_MS = 11 * 60_000
// plan.md BAK-28, BAK-29: the new volume Available, the new VM Stopped, each within 30 minutes.
const RESTORE_WITHIN_MS = 30 * 60_000
// plan.md BAK-29: currentAttachedVmId is the volume reconciler's, a pass after the VM is Stopped.
const ATTACHED_WITHIN_MS = 5 * 60_000
// One host read; no answer in this time is BAK-30 NOT COVERED, never a stop of the job.
const HOST_HOLD_MS = 5 * 60_000

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ProviderCommand/Enums/BackupCommandKeys.cs (the UTC day, yyyyMMdd)
function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, '')
}

// What is left of the budget for a wait of at most capMs; none left ⇒ the test is NOT COVERED.
function within(capMs: number): number {
  const left = WORK_ENDS_AT - Date.now()
  test.skip(left < 60_000, `NOT COVERED: the job's time is spent (${Math.round((Date.now() - STARTED) / 60_000)} minutes in)`)
  return Math.min(capMs, left)
}

// A host hold never skips the test: with no time left it waits 0 and BAK-30 is NOT COVERED.
function hostHoldMs(): number {
  return Math.max(0, Math.min(HOST_HOLD_MS, WORK_ENDS_AT - Date.now()))
}

// pollUntil cut to the budget: a timeout of a wait the budget cut short skips, a timeout of the row's own limit fails.
async function waitFor<T>(label: string, read: () => Promise<T>, done: (v: T) => boolean, shape: (v: T) => string,
  capMs: number, everyMs = 10_000): Promise<T> {
  const ms = within(capMs)
  try {
    return await pollUntil(label, read, done, shape, ms, everyMs)
  } catch (error) {
    if (ms < capMs && String(error).includes(`${label}: timed out`)) {
      test.skip(true, `NOT COVERED: ${label} not reached before the job's time ran out (${error})`)
    }
    throw error
  }
}

// OpenViCloud/titan-control-plane:Titan.Application/Services/Admin/Backup/RestoreArchives.cs (ClosestTo: the archive taken
// closest to the VM's, the earlier of two equally far, none further than 24 hours)
function closestTo(archives: any[], takenAt: string): any {
  let best: any = null
  for (const a of archives) {
    const d = Math.abs(Date.parse(a.takenAt) - Date.parse(takenAt))
    const bestD = best === null ? Infinity : Math.abs(Date.parse(best.takenAt) - Date.parse(takenAt))
    if (d < bestD || (d === bestD && Date.parse(a.takenAt) < Date.parse(best.takenAt))) {
      best = a
    }
  }
  return best !== null && Math.abs(Date.parse(best.takenAt) - Date.parse(takenAt)) <= 24 * 3_600_000 ? best : null
}

async function ids(path: string): Promise<string[]> {
  return (await get('tenant', path) as Array<{ id: string }>).map((r) => r.id).sort()
}

async function lists(): Promise<{ vms: string[], volumes: string[] }> {
  return { vms: await ids('/v1/tenant/vms'), volumes: await ids('/v1/tenant/volumes') }
}

function added(before: string[], after: string[]): string[] {
  return after.filter((id) => !before.includes(id))
}

async function itemOf(kind: 'vm' | 'volume', resourceId: string): Promise<any> {
  const backups = await get('admin', '/v1/admin/backups')
  return (backups.items as any[]).find((i) => i.kind === kind && i.resourceId === resourceId)
}

function itemShape(item: any): string {
  return item === undefined ? 'none' : `archives=${(item.archives as any[]).map((a) => a.backupKey).join(',') || 'none'} health=${item.health}`
}

// A test skipped or failed before leaves what the next ones read unset: they skip, in serial mode a failure stops them anyway.
const NOT_SET_UP = 'NOT COVERED: no archive of the VM and the volume was listed (the first test was N/A or NOT COVERED)'
const NO_RESTORES = 'NOT COVERED: the restores this case reads were not made (a test before was N/A or NOT COVERED)'

const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

// OpenViCloud/titan-admin-console:portal/src/i18n/en.ts, OpenViCloud/titan-admin-console:portal/src/i18n/vi.ts
// (common.cancel; adminBackups.restoreAction, restoreDialogTitle, restoreVmNameLabel, restoreVolumeNameLabel,
// recentRestoresTitle, kinds)
const ADMIN_WORDS = {
  en: { restore: 'Restore', dialog: (n: string) => `Restore ${n}`, cancel: 'Cancel', vmName: 'Name of the new VM',
    volumeName: 'Name of the new volume', recent: 'Recent restores', vm: 'VM', volume: 'Volume' },
  vi: { restore: 'Khôi phục', dialog: (n: string) => `Khôi phục ${n}`, cancel: 'Huỷ', vmName: 'Tên của VM mới',
    volumeName: 'Tên của ổ đĩa mới', recent: 'Khôi phục gần đây', vm: 'VM', volume: 'Ổ đĩa' },
}

// OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts
// (restored.badge, restored.description, vmDetail.costHintRestored, vmDetail.costHint, vms.listLabel, volumes.listLabel,
// quota.title, quota.vms, quota.volumes)
const PORTAL_WORDS = {
  en: {
    badge: 'Restored · free',
    description: 'Restored from a backup by the platform. Free of charge and outside your quota until you delete it. Snapshots you take of it are limited and billed as usual.',
    free: 'Free of charge until you delete it, also while the VM runs.',
    billed: 'Compute is billed while the VM is Running, Ready, Frozen or Error.',
    vmList: 'Virtual machines', volumeList: 'Volumes', quota: 'Quota', quotaVms: 'VMs', quotaVolumes: 'Volumes',
  },
  vi: {
    badge: 'Đã khôi phục · miễn phí',
    description: 'Nền tảng đã khôi phục tài nguyên này từ một bản sao lưu. Miễn phí và không tính vào hạn mức cho tới khi bạn xoá. Snapshot bạn tạo từ nó vẫn có giới hạn và tính tiền như thường.',
    free: 'Miễn phí cho tới khi bạn xoá, kể cả khi VM đang chạy.',
    billed: 'Compute được tính tiền khi VM ở trạng thái Running, Ready, Frozen hoặc Error.',
    vmList: 'Máy ảo', volumeList: 'Ổ đĩa', quota: 'Hạn mức', quotaVms: 'VM', quotaVolumes: 'Ổ đĩa',
  },
}

async function setLanguage(page: Page, url: string, lang: 'en' | 'vi'): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.evaluate((l) => localStorage.setItem('ovc-lang', l), lang)
  await page.reload({ waitUntil: 'networkidle' })
}

// A volume or VM still waiting on its own request (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs,
// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs).
function volumePending(v: any): boolean {
  return ['Creating', 'Attaching', 'Detaching', 'Deleting'].includes(v.status)
}

function vmPending(v: any): boolean {
  return ['Creating', 'Starting', 'Stopping', 'Snapshotting', 'Deleting'].includes(v.status)
}

// maxVms and maxNetworks are mandatory in the body; a cap not sent keeps its value
// (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs UpdateQuotaValidator, UpdateQuotaRequest).
async function setQuota(tenantId: string, body: Record<string, number>): Promise<void> {
  log(`quota ← ${JSON.stringify(body)}`)
  expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, body), 204)
}

// What the VM and volume caps count, as the customer portal counts it (OpenViCloud/titan-cloud-console:portal/src/lib/quota.ts,
// vmOccupiesQuota, volumeOccupiesQuota): not a restored one, nor one Deleting, Deleted, NotFound or Failed. BAK-39 checks
// it against the control plane's own count by a create refused at the caps.
const OUTSIDE_QUOTA = new Set(['Deleting', 'Deleted', 'NotFound', 'Failed'])

async function occupied(): Promise<{ vms: number, volumes: number }> {
  const count = (rows: any[]) => rows.filter((r) => !OUTSIDE_QUOTA.has(r.status) && r.restoredFromBackup !== true).length
  return { vms: count(await get('tenant', '/v1/tenant/vms')), volumes: count(await get('tenant', '/v1/tenant/volumes')) }
}

async function askVm(name: string, networkId: string): Promise<any> {
  const { clusterId, smallTier, templateId } = await envOf()
  return call('tenant', 'POST', '/v1/tenant/vms', { name, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey())
}

async function askVolume(name: string): Promise<any> {
  const { clusterId, volumeOfferingId } = await envOf()
  return call('tenant', 'POST', '/v1/tenant/volumes', { name, volumeOfferingId, clusterId, sizeGb: 1 }, newKey())
}

test.describe.serial('backup-restore', () => {
  test.describe.configure({ timeout: 72 * 60_000 })

  const vmName = `rg-rs-vm-${RUN}`
  const dataName = `rg-rs-data-${RUN}`
  const volName = `rg-rs-vol-${RUN}`
  const copyName = `rg-rs-copy-${RUN}`
  const lateName = `rg-rs-new-${RUN}`
  let tenantId = ''
  let vmId = ''
  let volumeId = ''
  let day = ''
  // the archives the restores name, read once both backups are listed
  let vmItem: any = null
  let volumeItem: any = null
  let listsBefore: { vms: string[], volumes: string[] } | null = null
  let afterBak28: { vms: string[], volumes: string[] } | null = null
  let restoredVolumeId = ''
  let newVmId = ''
  let copyVolumeId = ''
  let runningAt = ''
  // BAK-39: the caps the job found, given back after BAK-29 and in afterAll, and the counts it set them to
  let quotaBefore: { maxVms: number, maxNetworks: number, maxVolumes: number } | null = null
  let atCap: { vms: number, volumes: number } | null = null
  const usedPortals = { admin: false, tenant: false }
  // the source VM's status and address every 10 s from its backup to the end of BAK-29
  const seen: Array<{ at: number, status: string, ip: string | null }> = []
  let sampling = false
  let sampler: Promise<void> = Promise.resolve()

  test.beforeAll(async ({ browser }) => {
    startLog('backup-restore')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    sampling = false
    await sampler
    await cleanUp([
      ['quota', async () => {
        if (quotaBefore !== null) {
          await setQuota(tenantId, quotaBefore)
        }
      }],
      ['language', async () => {
        // BAK-34 and BAK-35 switch the language; leave none picked, so the next spec starts from the default.
        for (const [role, url] of [['admin', ADMIN], ['tenant', PORTAL]] as const) {
          if (usedPortals[role]) {
            const page = await pageOf(role)
            await page.goto(url + '/', { waitUntil: 'networkidle' })
            await page.evaluate(() => localStorage.removeItem('ovc-lang'))
          }
        }
      }],
      // VMs first: a VM's delete releases its volumes (titan-ops features/volume/design.md#vm-delete-releases-volumes).
      ['vms', async () => {
        const vms = (await get('tenant', '/v1/tenant/vms') as any[]).filter((v) => v.name.startsWith('rg-rs-') && v.status !== 'Deleted')
        await Promise.all(vms.map(async (v) => {
          await waitVm(`afterAll ${v.name} at rest`, v.id, (x) => !vmPending(x) || x.status === 'Deleting')
          if (!['Deleting', 'Deleted'].includes((await getVm(v.id)).status)) {
            expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${v.id}`), 202)
          }
          await pollUntil(`afterAll ${v.name} deleted`, () => getVm(v.id), (x) => x.status === 'Deleted', vmShape, 12 * 60_000, 10_000)
        }))
      }],
      ['volumes', async () => {
        const volumes = (await get('tenant', '/v1/tenant/volumes') as any[]).filter((v) => v.name.startsWith('rg-rs-'))
        await Promise.all(volumes.map(async (v) => {
          let at = await waitVolume(`afterAll ${v.name} at rest`, v.id, (x) => !volumePending(x) || x.status === 'Deleting')
          if (at.currentAttachedVmId !== null && at.status !== 'Deleting') {
            expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${v.id}/detach`), 202)
            at = await waitVolume(`afterAll ${v.name} detached`, v.id, (x) => x.currentAttachedVmId === null && !volumePending(x))
          }
          if (at.status !== 'Deleting' && at.status !== 'Deleted') {
            expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${v.id}`), 202)
          }
          await pollUntil(`afterAll ${v.name} deleted`, () => readVolume(v.id), (x) => x.status === 'Deleted', volumeShape, 12 * 60_000, 10_000)
        }))
      }],
      ['sessions', closeSessions],
    ])
  })

  // Not a case: what every case reads. titan-ops features/backup/design.md#incus-backup ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Backup/ListDiskBackupsQueryHandler.cs (HandleAsync:
  // resourceId and every Complete archive of a VM or volume, newest first) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/Contracts/BackupArchiveQueryResult.cs (backupKey, takenAt).
  test('restore: a VM with a volume attached, backed up today by the agent\'s Job, its archives listed', async () => {
    const before = await get('admin', '/v1/admin/backups')
    test.skip(before.readAt === null, 'NOT COVERED: this environment has no reading of the backup bucket (readAt is null): disk backup is not set up')
    tenantId = (await get('tenant', '/v1/tenant')).id
    const { clusterId, smallTier, volumeOfferingId } = await envOf()
    const network = await runNetwork()
    vmId = await createVm(vmName, smallTier, network.id)
    const reply = await call('tenant', 'POST', '/v1/tenant/volumes', { name: dataName, volumeOfferingId, clusterId, sizeGb: 1 }, newKey())
    expectStatus(reply, 202)
    volumeId = bodyOf(reply).volumeId as string
    await waitVm('source vm running', vmId, runs)
    await waitVolume('source volume', volumeId, (v) => v.status === 'Available')
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/attach`, { vmId }), 202)
    await waitVolume('source volume attached', volumeId, (v) => v.currentAttachedVmId === vmId && !volumePending(v))
    const source = await getVm(vmId)
    log(`source vm ${vmId} ${vmShape(source)}, volume ${volumeId} attached`)

    sampling = true
    sampler = (async () => {
      while (sampling) {
        try {
          const vm = await getVm(vmId)
          const last = seen[seen.length - 1]
          if (last === undefined || last.status !== vm.status || last.ip !== vm.ipAddress) {
            log(`source vm ${vm.status} ip=${vm.ipAddress}`)
          }
          seen.push({ at: Date.now(), status: vm.status, ip: vm.ipAddress })
        } catch (error) {
          log(`source vm read failed: ${error}`)
        }
        await sleep(10_000)
      }
    })()

    day = dayOf(new Date())
    const holdMs = within(HOLD_BACKUPS_MS)
    let go = false
    try {
      go = await hold('bak28', {
        vmIds: [vmId], volumeIds: [volumeId], day, cronJob: 'control-plane-job-backup-schedule',
        answer: 'phase4.py bak28: go-bak28 once today\'s backup rows of the VM and the volume are Done',
      }, holdMs)
    } catch (error) {
      log(`${error}`)
      test.skip(true, 'N/A — no L-x: nobody answered HOLD bak28')
    }
    test.skip(!go, 'NOT COVERED: the agent answered skip-bak28 (its L_BAK28_BACKUPS= line says why)')

    const goAt = Date.now()
    const read = await waitFor('archives listed', async () => {
      const backups = await get('admin', '/v1/admin/backups')
      const items = backups.items as any[]
      return {
        readAt: backups.readAt as string | null,
        vm: items.find((i) => i.kind === 'vm' && i.resourceId === vmId),
        volume: items.find((i) => i.kind === 'volume' && i.resourceId === volumeId),
      }
    }, (r) => r.readAt !== null && Date.parse(r.readAt) > goAt && (r.vm?.archives?.length ?? 0) > 0 && (r.volume?.archives?.length ?? 0) > 0,
    (r) => `readAt=${r.readAt} vm ${itemShape(r.vm)} volume ${itemShape(r.volume)}`, ARCHIVES_WITHIN_MS, 15_000)
    vmItem = read.vm
    volumeItem = read.volume
    log(`vm archive ${vmItem.archives[0].backupKey} (${vmItem.archives[0].takenAt}), volume archive ${volumeItem.archives[0].backupKey} (${volumeItem.archives[0].takenAt})`)
  })

  // titan-ops features/backup/design.md#restore-as-new-resource ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/RestoreVmFromBackupEndpoint.cs,
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/RestoreVolumeFromBackupEndpoint.cs (Roles("platform-admin"):
  // 403 to a tenant, 401 with no token) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/RestoreVmFromBackupCommandHandler.cs (HandleAsync, in
  // this order: the name, VM_NOT_FOUND, BACKUP_NOT_FOUND, VM_NAME_TAKEN in the owner's tenant) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/RestoreVolumeFromBackupCommandHandler.cs (VOLUME_NOT_FOUND) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/ErrorStatus.cs (NotFoundException 404, ConflictException 409) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Backup/IncusBackupKey.cs (BackupKeyPattern: every key
  // sent here has the shape, so no refusal is the validator's). Every call has an Idempotency-Key of its own.
  test('BAK-32 a tenant, no token, an archive of another resource, a name the tenant has and an unknown id are refused, and nothing is made', async () => {
    test.skip(vmItem === null || volumeItem === null, NOT_SET_UP)
    const vmKey = vmItem.archives[0].backupKey as string
    const volKey = volumeItem.archives[0].backupKey as string
    const vmKeys = (vmItem.archives as any[]).map((a) => a.backupKey)
    // a key of a real archive that is not the VM's (the volume's), else one no archive has
    const notTheVms = vmKeys.includes(volKey) ? '20000101T000000Z' : volKey
    const vmPath = `/v1/admin/backups/vms/${vmId}/restore`
    const volPath = `/v1/admin/backups/volumes/${volumeId}/restore`
    const name = `rg-rs-no-${RUN}`
    listsBefore = await lists()

    for (const [path, key] of [[vmPath, vmKey], [volPath, volKey]]) {
      expectStatus(await call('tenant', 'POST', path, { backupKey: key, name }, newKey()), 403)
    }
    for (const [path, key] of [[vmPath, vmKey], [volPath, volKey]]) {
      expectStatus(await call('anonymous', 'POST', path, { backupKey: key, name }, newKey()), 401)
    }
    log(`BAK-32 the VM's archive ${vmKey}; refused with ${notTheVms}`)
    expectError(await call('admin', 'POST', vmPath, { backupKey: notTheVms, name }, newKey()), 404, 'BACKUP_NOT_FOUND')
    expectError(await call('admin', 'POST', vmPath, { backupKey: vmKey, name: vmName }, newKey()), 409, 'VM_NAME_TAKEN')
    expectError(await call('admin', 'POST', `/v1/admin/backups/vms/${randomUUID()}/restore`, { backupKey: vmKey, name }, newKey()), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'POST', `/v1/admin/backups/volumes/${randomUUID()}/restore`, { backupKey: volKey, name }, newKey()), 404, 'VOLUME_NOT_FOUND')
    expect(await lists(), 'the refusals made no VM or volume').toEqual(listsBefore)
  })

  // plan.md BAK-39, its first half · titan-ops features/backup/design.md#restore-as-new-resource (free and outside the quota
  // until the tenant deletes it) · OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs
  // (VM_QUOTA_EXCEEDED, VOLUME_QUOTA_EXCEEDED). The caps stay there through BAK-28 and BAK-29: their 202 is the restore asked
  // at the caps.
  test('BAK-39 the tenant set at its VM and volume caps is refused one more VM and one more volume of its own', async () => {
    test.skip(vmItem === null || volumeItem === null, NOT_SET_UP)
    const row = (await get('admin', '/v1/tenants') as any[]).find((t) => t.id === tenantId)
    expect(row, `tenant ${tenantId} in GET /v1/tenants`).toBeDefined()
    quotaBefore = { maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxVolumes: row.maxVolumes }
    const counts = await occupied()
    log(`BAK-39 caps before ${JSON.stringify(quotaBefore)}; occupied ${JSON.stringify(counts)}`)
    await setQuota(tenantId, { maxVms: counts.vms, maxNetworks: quotaBefore.maxNetworks, maxVolumes: counts.volumes })
    atCap = counts
    const network = await runNetwork()
    expectError(await askVm(`rg-rs-cap-0-${RUN}`, network.id), 422, 'VM_QUOTA_EXCEEDED')
    expectError(await askVolume(`rg-rs-cap-0-${RUN}`), 422, 'VOLUME_QUOTA_EXCEEDED')
  })

  // titan-ops features/backup/design.md#restore-as-new-resource ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/RestoreVolumeFromBackupEndpoint.cs (202 {newVolumeId},
  // IRequiresIdempotencyKey) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/RestoreVolumeFromBackupCommandHandler.cs ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.Creation.cs (RestoreFromBackup: the source's size,
  // restoredFromBackup, no attachment asked) · OpenViCloud/titan-incus-worker:resource/volume/restore.go.
  // The data inside is NOT COVERED (plan.md: a file written and read in the guest).
  test('BAK-28 the admin restores the volume\'s newest archive as a new volume of the tenant, free and unattached', async () => {
    test.skip(vmItem === null || volumeItem === null, NOT_SET_UP)
    const reply = await call('admin', 'POST', `/v1/admin/backups/volumes/${volumeId}/restore`,
      { backupKey: volumeItem.archives[0].backupKey, name: volName }, newKey())
    expectStatus(reply, 202)
    expect(Object.keys(bodyOf(reply))).toEqual(['newVolumeId'])
    restoredVolumeId = bodyOf(reply).newVolumeId as string
    afterBak28 = await lists()
    log(`BAK-28 new volume ${restoredVolumeId} from ${volumeItem.archives[0].backupKey}`)

    const restored = await waitFor('BAK-28 new volume', () => readVolume(restoredVolumeId), (v) => v.status !== 'Creating',
      volumeShape, RESTORE_WITHIN_MS)
    const source = await readVolume(volumeId)
    log(`BAK-28 new ${volumeShape(restored)} restored=${restored.restoredFromBackup} size=${restored.sizeGb}; source ${volumeShape(source)} restored=${source.restoredFromBackup}`)
    expect(restored.status).toBe('Available')
    expect(restored.name).toBe(volName)
    expect(restored.restoredFromBackup).toBe(true)
    expect(restored.sizeGb).toBe(source.sizeGb)
    expect(restored.currentAttachedVmId).toBeNull()
    expect(restored.desiredAttachedVmId).toBeNull()
    expect(source.currentAttachedVmId).toBe(vmId)
    expect(source.restoredFromBackup).toBe(false)
  })

  // plan.md BAK-32, its last part: the lists read right after BAK-28's 202 hold that new volume and nothing the refusals made.
  test('BAK-32 the lists read right after the volume restore\'s 202 add its new volume only', async () => {
    test.skip(listsBefore === null || afterBak28 === null, NOT_SET_UP)
    expect(added(listsBefore!.vms, afterBak28!.vms), 'VMs added').toEqual([])
    expect(added(listsBefore!.volumes, afterBak28!.volumes), 'volumes added').toEqual([restoredVolumeId])
  })

  // titan-ops features/backup/design.md#restore-as-new-resource ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/RestoreVmFromBackupEndpoint.cs (202 {newVmId}) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/RestoreVmFromBackupCommandHandler.cs (every volume
  // Incus holds attached to the VM comes with it under its own name, asked onto the new VM) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.Creation.cs (RestoreFromBackup: DesiredAttachedVmId) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.Observation.cs (currentAttachedVmId from the reconciler) ·
  // OpenViCloud/titan-incus-worker:resource/vm/restore.go (Restore: the copy is left stopped; planImport: a volatile.uuid and
  // MAC of its own, so it gets an address of its own). BAK-30's two host reads are the agent's, at the two holds below.
  test('BAK-29 the admin restores the VM\'s newest archive as a new VM with a copy of its volume, Stopped, then started with an address of its own', async () => {
    test.skip(vmItem === null || volumeItem === null, NOT_SET_UP)
    const source = await getVm(vmId)
    const sourceIp = source.ipAddress as string
    const project = projectOf(tenantId)
    const sourceOnIncus = incusName('vm', vmId)
    try {
      const answered = await hold('bak30-before', {
        project, vm: sourceOnIncus,
        read: `sudo incus config get --project ${project} ${sourceOnIncus} volatile.eth0.hwaddr`,
        answer: 'phase4.py host … then phase4.py go bak30-before (skip: no host read)',
      }, hostHoldMs())
      log(`BAK-30 before: ${answered ? 'go' : 'skip'}`)
    } catch (error) {
      log(`BAK-30 NOT COVERED: ${error}`)
    }

    const vmArchive = vmItem.archives[0]
    // the handler reads the volume's archives at the POST: the one closest to the VM's goes with it
    const volumeArchives = (await itemOf('volume', volumeId))?.archives ?? []
    const closest = closestTo(volumeArchives, vmArchive.takenAt)
    expect(closest, `an archive of ${dataName} within 24 hours of ${vmArchive.takenAt}`).not.toBeNull()
    const reply = await call('admin', 'POST', `/v1/admin/backups/vms/${vmId}/restore`, { backupKey: vmArchive.backupKey, name: copyName }, newKey())
    expectStatus(reply, 202)
    expect(Object.keys(bodyOf(reply))).toEqual(['newVmId'])
    newVmId = bodyOf(reply).newVmId as string
    const asked = (await get('tenant', '/v1/tenant/volumes') as any[]).filter((v) => v.desiredAttachedVmId === newVmId)
    log(`BAK-29 new vm ${newVmId} from ${vmArchive.backupKey}; volumes asked onto it: ${asked.map((v) => `${v.id} ${v.name}`).join(', ')}; ${dataName} goes with ${closest.backupKey}`)
    expect(asked.length, 'one copy of the volume, asked onto the new VM at once').toBe(1)
    copyVolumeId = asked[0].id
    expect(asked[0].name).toBe(dataName)
    expect(asked[0].restoredFromBackup).toBe(true)

    const stopped = await waitFor('BAK-29 new vm', () => getVm(newVmId), (v) => v.status !== 'Creating', vmShape, RESTORE_WITHIN_MS)
    expect(stopped.status).toBe('Stopped')
    expect(stopped.name).toBe(copyName)
    expect(stopped.restoredFromBackup).toBe(true)
    const attached = await waitFor('BAK-29 copy attached', async () => (await get('tenant', '/v1/tenant/volumes') as any[])
      .filter((v) => v.currentAttachedVmId === newVmId), (on) => on.length > 0 && on.every((v) => !volumePending(v)),
    (on) => on.map((v) => `${v.id} ${volumeShape(v)}`).join('; ') || 'none', ATTACHED_WITHIN_MS)
    expect(attached.map((v) => v.id), 'exactly the copy is attached to the new VM').toEqual([copyVolumeId])
    expect(attached[0].status).toBe('Available')

    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${newVmId}/start`), 202)
    const up = await waitFor('BAK-29 new vm started', () => getVm(newVmId), (v) => runs(v) && v.ipAddress !== null, vmShape, OBSERVED_WITHIN_MS)
    runningAt = new Date().toISOString()
    log(`BAK-29 new vm ${vmShape(up)}, source ip ${sourceIp}`)
    expect(up.ipAddress).not.toBe(sourceIp)

    try {
      const answered = await hold('bak30-after', {
        project, vm: sourceOnIncus, copy: incusName('vm', newVmId), network: `net-${source.networkId}`,
        reads: ['volatile.eth0.hwaddr', 'volatile.uuid'].flatMap((k) => [sourceOnIncus, incusName('vm', newVmId)]
          .map((vm) => `sudo incus config get --project ${project} ${vm} ${k}`)).concat(['sudo ovn-nbctl show']),
        answer: 'phase4.py host … for each read, then phase4.py go bak30-after (skip: no host read)',
      }, hostHoldMs())
      log(`BAK-30 after: ${answered ? 'go' : 'skip'}`)
    } catch (error) {
      log(`BAK-30 NOT COVERED: ${error}`)
    }

    sampling = false
    await sampler
    const off = seen.filter((s) => !(s.status === 'Running' || s.status === 'Ready') || s.ip !== sourceIp)
    log(`BAK-29 source vm reads: ${seen.length}, off: ${off.map((s) => `${s.status} ${s.ip}@${new Date(s.at).toISOString()}`).join(' ') || 'none'}`)
    expect(seen.length, 'the source VM was read during the run').toBeGreaterThan(0)
    expect(off.length, 'the source VM runs throughout and keeps its address').toBe(0)
  })

  // plan.md BAK-39, its second half: the restores (BAK-28's volume, BAK-29's VM and the copy of its volume) took none of the
  // room, so one cap more lets the tenant make exactly one VM and one volume; each is deleted at once, the caps given back.
  test('BAK-39 after the restores, one cap more lets the tenant make exactly one more VM and one more volume', async () => {
    test.skip(quotaBefore === null || atCap === null, NOT_SET_UP)
    // the caps go back however the test ends, a skip too: a skip does not stop the tests after it, and BAK-38 makes a volume
    try {
      test.skip(newVmId === '' || copyVolumeId === '' || restoredVolumeId === '', NO_RESTORES)
      const counts = await occupied()
      log(`BAK-39 occupied after the restores ${JSON.stringify(counts)}, at the caps ${JSON.stringify(atCap)}`)
      expect(counts, 'the tenant holds what it held at the caps, the restores aside').toEqual(atCap)
      await setQuota(tenantId, { maxVms: atCap!.vms + 1, maxNetworks: quotaBefore!.maxNetworks, maxVolumes: atCap!.volumes + 1 })
      const network = await runNetwork()
      const vm = await askVm(`rg-rs-cap-1-${RUN}`, network.id)
      expectStatus(vm, 202)
      const capVmId = bodyOf(vm).vmId as string
      expectError(await askVm(`rg-rs-cap-2-${RUN}`, network.id), 422, 'VM_QUOTA_EXCEEDED')
      const volume = await askVolume(`rg-rs-cap-1-${RUN}`)
      expectStatus(volume, 202)
      const capVolumeId = bodyOf(volume).volumeId as string
      expectError(await askVolume(`rg-rs-cap-2-${RUN}`), 422, 'VOLUME_QUOTA_EXCEEDED')
      log(`BAK-39 made vm ${capVmId} and volume ${capVolumeId} under one cap more`)
      // deleted from rest, as afterAll deletes; afterAll waits for Deleted
      await waitFor('BAK-39 vm at rest', () => getVm(capVmId), (v) => !vmPending(v), vmShape, OBSERVED_WITHIN_MS)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${capVmId}`), 202)
      await waitFor('BAK-39 volume at rest', () => readVolume(capVolumeId), (v) => !volumePending(v), volumeShape, OBSERVED_WITHIN_MS)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${capVolumeId}`), 202)
    } finally {
      await setQuota(tenantId, quotaBefore!)
    }
  })

  // titan-ops features/backup/design.md#restore-as-new-resource · titan-ops architecture/tenancy-and-admin.md#admin-audit ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Admin/Backup/RestoreAudit.cs (VmAction, VolumeAction; Stage:
  // the new resource's id, the source's tenant, detail "source=<id> backup=<key>") ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/AdminAuditLog/Contracts/AdminAuditLogQueryResult.cs.
  test('BAK-33 one audit row per resource the restores made, owned by the tenant, naming the source and the archive', async () => {
    test.skip(newVmId === '' || copyVolumeId === '' || restoredVolumeId === '', NO_RESTORES)
    const vmArchive = vmItem.archives[0]
    const closest = closestTo((await itemOf('volume', volumeId))?.archives ?? [], vmArchive.takenAt)
    const rows = await get('admin', '/v1/admin/audit-log?limit=50') as any[]
    const expected = [
      { action: 'vm.restore.cross_tenant', resourceType: 'vm', resourceId: newVmId, detail: `source=${vmId} backup=${vmArchive.backupKey}` },
      { action: 'volume.restore.cross_tenant', resourceType: 'volume', resourceId: restoredVolumeId, detail: `source=${volumeId} backup=${volumeItem.archives[0].backupKey}` },
      { action: 'volume.restore.cross_tenant', resourceType: 'volume', resourceId: copyVolumeId, detail: `source=${volumeId} backup=${closest?.backupKey}` },
    ]
    for (const e of expected) {
      const found = rows.filter((r) => r.resourceId === e.resourceId)
      log(`BAK-33 ${e.resourceId}: ${JSON.stringify(found.map((r) => ({ action: r.action, resourceType: r.resourceType, ownerTenantId: r.ownerTenantId, detail: r.detail })))}`)
      expect(found.length, `one audit row of ${e.resourceId}`).toBe(1)
      expect(found[0].action).toBe(e.action)
      expect(found[0].resourceType).toBe(e.resourceType)
      expect(found[0].ownerTenantId).toBe(tenantId)
      expect(found[0].detail).toBe(e.detail)
    }
  })

  // titan-ops features/backup/design.md#restore-as-new-resource · titan-ops features/backup/design.md#backups-page ·
  // OpenViCloud/titan-admin-console:portal/src/admin/pages/AdminBackupsPage.tsx (BackupTable: a Restore button only on a VM or
  // volume row with an archive; RestoreDialog: one radio per archive, the newest checked, the name `<name>-restored`, Cancel
  // closes; RecentRestoresBlock: kind, name, tenant, the server's state word) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Backup/ListBackupRestoresQueryHandler.cs (state done).
  test('BAK-34 the Backups page offers Restore on the source VM and volume, the dialog cancels without a request, and lists the three restores done, in English then Vietnamese', async () => {
    test.skip(newVmId === '' || copyVolumeId === '' || restoredVolumeId === '', NO_RESTORES)
    const backups = await get('admin', '/v1/admin/backups')
    const restores = (backups.restores as any[]).filter((r) => [newVmId, restoredVolumeId, copyVolumeId].includes(r.resourceId))
    log(`BAK-34 restores: ${JSON.stringify(restores.map((r) => ({ kind: r.kind, name: r.name, state: r.state })))}`)
    expect(restores.map((r) => `${r.kind} ${r.name} ${r.state}`).sort())
      .toEqual([`vm ${copyName} done`, `volume ${dataName} done`, `volume ${volName} done`].sort())
    const tenantName = (await get('admin', '/v1/tenants') as any[]).find((t) => t.id === tenantId)?.name as string
    expect(tenantName, `tenant ${tenantId} in GET /v1/tenants`).toBeTruthy()
    const vmNow = (backups.items as any[]).find((i) => i.kind === 'vm' && i.resourceId === vmId)
    const volumeNow = (backups.items as any[]).find((i) => i.kind === 'volume' && i.resourceId === volumeId)
    const others = (backups.items as any[]).filter((i) => i.kind === 'postgres' || i.kind === 'cluster')
    // The copy of the volume keeps its source's name; it has an archive only if the hourly pass backed it up since BAK-29.
    const dataWithArchives = (backups.items as any[]).filter((i) => i.kind === 'volume' && i.name === dataName && (i.archives as any[]).length > 0)
    expect(dataWithArchives.map((i) => i.resourceId), `the source volume ${volumeId} has an archive`).toContain(volumeId)
    usedPortals.admin = true
    const page = await pageOf('admin')
    const posts: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/restore')) {
        posts.push(r.url())
      }
    })
    for (const lang of ['en', 'vi'] as const) {
      const w = ADMIN_WORDS[lang]
      await setLanguage(page, ADMIN + '/backups', lang)
      const rowOf = (name: string) => page.getByRole('row').filter({ has: page.locator('td:first-child', { hasText: exactly(name) }) })
      const restoreIn = (row: ReturnType<typeof rowOf>) => row.getByRole('button', { name: w.restore, exact: true })
      await expect(rowOf(vmName)).toHaveCount(1)
      await expect(restoreIn(rowOf(vmName))).toHaveCount(1)
      // of the rows of that name, those with an archive (the source's, BAK-36's Job not run yet) have the button
      await expect(restoreIn(rowOf(dataName))).toHaveCount(dataWithArchives.length)
      for (const item of others) {
        await expect(restoreIn(rowOf(item.name)), `${item.kind} ${item.name}: no Restore`).toHaveCount(0)
      }

      // Opens the dialog of one Restore button and closes it with Cancel. It is item's dialog when the archive checked is
      // item's newest; only then are its radios, name and screenshot checked. The copy of the volume (BAK-29) keeps its
      // source's name and can have an archive of its own, and the page shows no id. A backupKey is the time of the archive
      // (OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Backup/IncusBackupKey.cs), and the copy's is
      // taken after BAK-29, later than the source's newest: the archive checked tells the two apart.
      const dialogOf = async (button: ReturnType<typeof restoreIn>, item: any, label: string): Promise<boolean> => {
        await button.click()
        const dialog = page.getByRole('dialog', { name: w.dialog(item.name) })
        await expect(dialog).toBeVisible()
        const checked = dialog.locator('input[type="radio"]:checked')
        await expect(checked).toHaveCount(1)
        const key = await checked.inputValue()
        const mine = key === item.archives[0].backupKey
        log(`BAK-34 ${lang}: a dialog of ${item.kind} ${item.name} has ${key} checked; ${mine ? 'its own newest' : 'not its archive'}`)
        if (mine) {
          await expect(dialog.getByRole('radio')).toHaveCount((item.archives as any[]).length)
          await expect(dialog.getByLabel(label)).toHaveValue(`${item.name}-restored`)
          await page.screenshot({ path: `${RESULTS}/BAK-34-${lang}-${item.kind}-dialog.png` })
        }
        await dialog.getByRole('button', { name: w.cancel, exact: true }).click()
        await expect(dialog).toBeHidden()
        return mine
      }
      expect(await dialogOf(restoreIn(rowOf(vmName)), vmNow, w.vmName), `the dialog of VM ${vmName} has its newest archive checked`).toBe(true)
      let sources = 0
      for (let i = 0; i < dataWithArchives.length; i++) {
        if (await dialogOf(restoreIn(rowOf(dataName)).nth(i), volumeNow, w.volumeName)) {
          sources++
        }
      }
      expect(sources, `of the ${dataWithArchives.length} rows named ${dataName} with an archive, one dialog has the source volume's newest checked`).toBe(1)

      const recent = page.getByRole('region', { name: w.recent })
      for (const [kind, name] of [['vm', copyName], ['volume', volName], ['volume', dataName]] as const) {
        const line = recent.locator('li').filter({ hasText: name })
        await expect(line, `${kind} ${name}: one line`).toHaveCount(1)
        await expect(line).toContainText(`${w[kind]} ${name}`)
        await expect(line).toContainText(tenantName)
        await expect(line).toContainText('done')
      }
      await recent.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${RESULTS}/BAK-34-${lang}-recent.png` })
    }
    expect(posts, 'Cancel sends no restore').toEqual([])
    await setLanguage(page, ADMIN + '/backups', 'en')
  })

  // titan-ops features/backup/design.md#restore-as-new-resource ·
  // OpenViCloud/titan-cloud-console:portal/src/components/RestoredBadge.tsx (the badge, with its description hidden visually
  // in a list) · OpenViCloud/titan-cloud-console:portal/src/pages/VmDetailPage.tsx (the badge, restored.description and
  // vmDetail.costHintRestored instead of vmDetail.costHint) · OpenViCloud/titan-cloud-console:portal/src/pages/VmListPage.tsx ·
  // OpenViCloud/titan-cloud-console:portal/src/pages/VolumeListPage.tsx (attachedToLabel: the VM's name) ·
  // OpenViCloud/titan-cloud-console:portal/src/lib/quota.ts (vmOccupiesQuota, volumeOccupiesQuota: never a restored one) ·
  // OpenViCloud/titan-cloud-console:portal/src/components/QuotaCard.tsx (QuotaRow: `${used} / ${cap}`).
  test('BAK-35 the customer portal labels the new VM and volumes Restored · free, the VM page says it is free, the quota card leaves them out, in English then Vietnamese', async () => {
    test.skip(newVmId === '' || copyVolumeId === '' || restoredVolumeId === '', NO_RESTORES)
    const tenant = await get('tenant', '/v1/tenant')
    const outside = new Set(['Deleting', 'Deleted', 'NotFound', 'Failed'])
    const vms = await get('tenant', '/v1/tenant/vms') as any[]
    const volumes = await get('tenant', '/v1/tenant/volumes') as any[]
    const occupying = (rows: any[]) => rows.filter((r) => !outside.has(r.status) && r.restoredFromBackup !== true).length
    const live = (rows: any[]) => rows.filter((r) => !outside.has(r.status)).length
    log(`BAK-35 quota vms ${occupying(vms)} (${live(vms)} with the restored) / ${tenant.maxVms}, volumes ${occupying(volumes)} (${live(volumes)}) / ${tenant.maxVolumes}`)
    expect(live(vms) - occupying(vms), 'the restored VM is live and not counted').toBe(1)
    expect(live(volumes) - occupying(volumes), 'the two restored volumes are live and not counted').toBe(2)
    usedPortals.tenant = true
    const page = await pageOf('tenant')
    for (const lang of ['en', 'vi'] as const) {
      const w = PORTAL_WORDS[lang]
      await setLanguage(page, PORTAL + '/vms', lang)
      const vmRow = (name: string) => page.getByRole('list', { name: w.vmList }).getByRole('listitem').filter({ hasText: name })
      await expect(vmRow(copyName)).toHaveCount(1)
      await expect(vmRow(copyName)).toContainText(w.badge)
      await expect(vmRow(vmName)).toHaveCount(1)
      await expect(vmRow(vmName)).not.toContainText(w.badge)
      await page.screenshot({ path: `${RESULTS}/BAK-35-${lang}-vms.png` })

      await page.goto(`${PORTAL}/vms/${newVmId}`, { waitUntil: 'networkidle' })
      await expect(page.getByRole('heading', { name: copyName })).toBeVisible()
      await expect(page.getByText(w.badge, { exact: true })).toBeVisible()
      await expect(page.getByText(w.description, { exact: true })).toBeVisible()
      await expect(page.getByText(w.free, { exact: true })).toBeVisible()
      await expect(page.getByText(w.billed, { exact: true })).toHaveCount(0)
      await page.screenshot({ path: `${RESULTS}/BAK-35-${lang}-vm.png` })

      await page.goto(`${PORTAL}/volumes`, { waitUntil: 'networkidle' })
      const volumeRows = page.getByRole('list', { name: w.volumeList }).getByRole('listitem')
      // the copy keeps its source's name: the two rows of that name differ by the VM they are attached to
      await expect(volumeRows.filter({ hasText: dataName }).filter({ hasText: copyName })).toContainText(w.badge)
      await expect(volumeRows.filter({ hasText: dataName }).filter({ hasText: vmName })).toHaveCount(1)
      await expect(volumeRows.filter({ hasText: dataName }).filter({ hasText: vmName })).not.toContainText(w.badge)
      await expect(volumeRows.filter({ hasText: volName })).toContainText(w.badge)
      await page.screenshot({ path: `${RESULTS}/BAK-35-${lang}-volumes.png` })

      await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
      const card = page.getByRole('region', { name: w.quota })
      const quotaRow = (label: string) => card.locator('[data-quota-row]').filter({ has: page.getByText(label, { exact: true }) })
      await expect(quotaRow(w.quotaVms)).toContainText(`${occupying(vms)} / ${tenant.maxVms}`)
      await expect(quotaRow(w.quotaVolumes)).toContainText(`${occupying(volumes)} / ${tenant.maxVolumes}`)
      await card.screenshot({ path: `${RESULTS}/BAK-35-${lang}-quota.png` })
    }
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
  })

  // titan-ops features/backup/design.md#restore-as-new-resource ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/RestoreVmFromBackupCommandHandler.cs (every volume
  // Incus holds attached to the VM needs an archive within 24 hours of the VM's, checked before anything is made) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/ErrorStatus.cs (BusinessException 422; title is the message) ·
  // OpenViCloud/titan-control-plane:Titan.Tests/Services/RestoreVmFromBackupTests.cs (AnAttachedVolumeWithNoArchive_Refuses_NamingTheVolume).
  test('BAK-38 a VM with an attached volume that has no archive is refused, naming the volume, and nothing is made', async () => {
    test.skip(vmItem === null || volumeItem === null, NOT_SET_UP)
    const { clusterId, volumeOfferingId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/volumes', { name: lateName, volumeOfferingId, clusterId, sizeGb: 1 }, newKey())
    expectStatus(reply, 202)
    const lateId = bodyOf(reply).volumeId as string
    await waitFor('BAK-38 volume', () => readVolume(lateId), (v) => v.status !== 'Creating', volumeShape, OBSERVED_WITHIN_MS)
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${lateId}/attach`, { vmId }), 202)
    const attached = await waitFor('BAK-38 volume attached', () => readVolume(lateId), (v) => !volumePending(v), volumeShape, OBSERVED_WITHIN_MS)
    expect(attached.status).toBe('Available')
    expect(attached.currentAttachedVmId).toBe(vmId)
    // the hourly pass may have backed it up meanwhile: the handler reads the same archives as this list
    test.skip(((await itemOf('volume', lateId))?.archives ?? []).length > 0, `NOT COVERED: ${lateName} has an archive already (the hourly pass backed it up)`)
    const before = await lists()
    const refused = await call('admin', 'POST', `/v1/admin/backups/vms/${vmId}/restore`,
      { backupKey: vmItem.archives[0].backupKey, name: `rg-rs-copy2-${RUN}` }, newKey())
    log(`BAK-38 ${refused.status} ${refused.text.slice(0, 300)}`)
    expectError(refused, 422, 'BACKUP_OF_ATTACHED_VOLUME_NOT_FOUND')
    expect(bodyOf(refused).title).toContain(`Volume '${lateName}' (${lateId})`)
    expect(await lists(), 'the refusal made no VM or volume').toEqual(before)
    // Gone before BAK-36's Job, which would otherwise back it up too: one disk less in the tenant's backup lane.
    try {
      expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${lateId}/detach`), 202)
      await waitVolume('BAK-38 volume detached', lateId, (v) => v.currentAttachedVmId === null && !volumePending(v))
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${lateId}`), 202)
      await waitVolume('BAK-38 volume deleted', lateId, (v) => v.status === 'Deleted')
    } catch (error) {
      log(`BAK-38 volume left for afterAll: ${error}`)
    }
  })

  // titan-ops features/backup/design.md#restore-as-new-resource ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/ScheduleBackupsCommandHandler.cs (HandleAsync: every
  // VM and volume Incus holds, a restored one too) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs
  // (IsOnIncus, IsBilled) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs (IsBilled). The SQL of both rows is
  // `phase4.py bak36`'s (README §Phase 4): its L_BAK31= and L_BAK36= lines are the verdicts; this test's ✓ says the hold was
  // answered go.
  test('BAK-31 and BAK-36 the agent reads no usage of the restored VM and volumes after a meter pass, and their backups of the day Done', async () => {
    test.skip(newVmId === '' || copyVolumeId === '' || restoredVolumeId === '', NO_RESTORES)
    test.skip(runningAt === '', NO_RESTORES)
    test.skip(dayOf(new Date()) !== day, `NOT COVERED: the run crossed 00:00Z (the source's backups are of ${day})`)
    const holdMs = within(HOLD_BACKUPS_MS)
    let go = false
    try {
      go = await hold('bak36', {
        vmIds: [newVmId], volumeIds: [restoredVolumeId, copyVolumeId], day, sourceVmId: vmId, runningAt,
        cronJob: 'control-plane-job-backup-schedule', meterCronJob: 'control-plane-job-meter',
        answer: 'phase4.py bak36: go-bak36 once today\'s backup rows of the restored VM and volumes ended',
      }, holdMs)
    } catch (error) {
      log(`${error}`)
      test.skip(true, 'N/A — no L-x: nobody answered HOLD bak36')
    }
    test.skip(!go, 'NOT COVERED: the agent answered skip-bak36 (its L_BAK36= line says why)')
  })
})
