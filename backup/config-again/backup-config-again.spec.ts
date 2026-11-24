import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, expectStatus, get, log, pollUntil, sleep, startLog } from './api'
import { cleanUp } from './clean-up'
import { hold } from './host-hold'
import { RUN, createVm, envOf, getVm, runNetwork, runs, vmShape, waitVm } from './fixtures'

// Cases BAK-22 and BAK-23 of plan.md (L-x; on prd only until titan-ops status/known-state.md#first-real-customer). A job
// of its own (run-module.sh … backup/config-again …, job regression-config-again-<label>), like backup/command-wait:
// the backup module's ConfigMap takes only the files of backup/, and the sequential lane never waits on the agent's step.
// The spec makes a VM of its own, then logs HOLD bak22 {vmId, vmName, clusterId, backupKey, vmCreatedAt} and waits for
// the agent's `python3 phase4.py bak22` (README §Phase 4): two Jobs from CronJob control-plane-job-backup-schedule, the
// first queues the VM's backup, the second, once that backup is Done, queues the config of that UTC hour; go-bak22
// comes when that config's row is Done (psql SELECT on core.provider_commands, read only; the L_BAK22= line is the
// verdict of BAK-22's SQL part). The spec then reads GET /v1/admin/backups once the bucket was read after the go: the
// API part of BAK-22, and BAK-23's (the config item's health). BAK-23's rows of core.backups are the same command's
// read (its L_BAK23= line). skip-bak22 is NOT COVERED or a FAIL of the SQL part, as the L_BAK22= line says.

// The CronJob's own pass is due at minute 0 of every hour and may start up to 120 s later
// (OpenViCloud/titan-local-cluster:base/control-plane/scheduled-jobs.yaml, control-plane-job-backup-schedule): a VM it
// sees before the agent's first Job gets its backup from that pass, and the case is NOT COVERED. The run network is
// found first, then the VM is asked only from minute 2 to minute 49, so that it is up before the next hour; the agent
// creates its Jobs only from minute 3, while that CronJob has no Job running. A start late in the hour leaves the agent
// less of it: the CronJob's next pass may then queue the config itself, which is NOT COVERED too.
const FIRST_START_MINUTE = 2
const LAST_START_MINUTE = 50
// The runner's job ends after 90 minutes (OpenViCloud/titan-local-cluster:base/regression-runner/cronjob.yaml
// activeDeadlineSeconds 5400), the results copied before that: the test is capped at 72 minutes (the wait for a start,
// 12 minutes at most, the VM, the hold and the read; test.describe.configure below) and afterAll, which deletes the VM,
// at 15, which leaves 3 for the runner's start and the copy.
// `phase4.py bak22 --hold-minutes` is this wait: the agent creates no Job whose waits would outlast it; a go after it is
// not taken (this test is then N/A, the agent's L_BAK22= NOT_COVERED).
const HOLD_AGENT_MS = 40 * 60_000
// CronJob control-plane-job-backup-status runs every 5 minutes (OpenViCloud/titan-local-cluster:base/control-plane/scheduled-jobs.yaml):
// two of its passes and the pass itself.
const READ_WITHIN_MS = 11 * 60_000
// A delete waits behind its VM's backup while that is Leased (titan-ops features/provider/design.md#tenant-lane), which
// the agent waits for up to 15 minutes (`phase4.py bak22 --backup-minutes`): 13 of afterAll's 15 (the VM is at rest
// already unless it never came up).
const DELETED_WITHIN_MS = 13 * 60_000

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ProviderCommand/Enums/BackupCommandKeys.cs (Vm: the UTC day, yyyyMMdd)
function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, '')
}

function startOf(now: Date): Date {
  const minute = now.getUTCMinutes()
  if (minute >= FIRST_START_MINUTE && minute < LAST_START_MINUTE) {
    return now
  }
  const start = new Date(now)
  start.setUTCMinutes(FIRST_START_MINUTE, 0, 0)
  if (minute >= LAST_START_MINUTE) {
    start.setUTCHours(start.getUTCHours() + 1)
  }
  return start
}

function itemShape(item: any): string {
  return item === undefined ? 'none' : `takenAt=${item.takenAt} health=${item.health} reason=${item.reason}`
}

test.describe.serial('backup-config-again', () => {
  test.describe.configure({ timeout: 72 * 60_000 })

  const vmName = `rg-bak22-${RUN}`
  let vmId = ''
  // the VM's item and the cluster's config item at the read of the bucket after the go
  let measured: { backups: any[], configs: any[] } | null = null

  test.beforeAll(async ({ browser }) => {
    startLog('backup-config-again')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    await cleanUp([
      ['vm', async () => {
        if (vmId === '') {
          return
        }
        await waitVm('BAK-22 vm at rest', vmId, (v) => v.status !== 'Creating' && v.status !== 'Starting')
        if ((await getVm(vmId)).status !== 'Deleted') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`), 202)
        }
        await pollUntil('BAK-22 vm deleted', () => getVm(vmId), (v) => v.status === 'Deleted', vmShape, DELETED_WITHIN_MS, 10_000)
      }],
      ['sessions', closeSessions],
    ])
  })

  // titan-ops features/backup/design.md#cluster-backup (another config the same day once a disk's backup row is newer
  // than the newest config that is Done) · titan-ops features/backup/design.md#backup-status-reads-the-bucket (readAt) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/ScheduleBackupsCommandHandler.cs
  // (DisksOfTheDayAsync, ADiskIsNewerThanTheLastConfigAsync) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Backup/ListDiskBackupsQueryHandler.cs (HandleAsync: the
  // item of a VM carries its display name, the item of a cluster the cluster's name; takenAt is the newest record's) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Abstractions/IAdminClusterService.cs (AdminClusterDto: clusterId, name) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/ListBackupsQueryHandler.cs (HandleAsync: readAt) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/BackupHealthPolicy.cs (ForDisk: Unknown when the
  // bucket could not be read or the reading is too old) · titan-ops features/backup/user-stories.md#bak-b03.
  test('BAK-22 a VM made after the day\'s config of its cluster, then a read of the bucket after the agent\'s go', async () => {
    const { clusterId, smallTier } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as Array<{ clusterId: string, name: string }>
    const clusterName = clusters.find((c) => c.clusterId === clusterId)?.name ?? ''
    expect(clusterName, `cluster ${clusterId} in ${JSON.stringify(clusters.map((c) => c.clusterId))}`).not.toEqual('')
    const configOf = (backups: any) => (backups.items as any[]).filter((i) => i.kind === 'cluster' && i.name === clusterName)

    const before = await get('admin', '/v1/admin/backups')
    log(`BAK-22 before: readAt=${before.readAt} config of ${clusterName}: ${itemShape(configOf(before)[0])}`)
    test.skip(before.readAt === null, 'NOT COVERED: this environment has no reading of the backup bucket (readAt is null): disk backup is not set up')

    const network = await runNetwork()
    const now = new Date()
    const start = startOf(now)
    test.skip(dayOf(start) !== dayOf(now), `NOT COVERED: the start, minute ${FIRST_START_MINUTE} of the next hour, is past 00:00Z`)
    if (start.getTime() > now.getTime()) {
      log(`BAK-22 waits ${Math.round((start.getTime() - now.getTime()) / 1000)} s for minute ${FIRST_START_MINUTE} of the hour: the CronJob's own backup pass is due at minute 0`)
      await sleep(start.getTime() - now.getTime())
    }
    vmId = await createVm(vmName, smallTier, network.id)
    await waitVm('BAK-22 vm running', vmId, (v) => runs(v))
    const vm = await getVm(vmId)
    expect(vm.clusterId).toBe(clusterId)
    const day = dayOf(new Date())

    let go = false
    try {
      go = await hold('bak22', {
        vmId, vmName, clusterId, backupKey: `vm-backup-${vmId}-${day}`, vmCreatedAt: new Date(vm.createdAt).toISOString(),
        cronJob: 'control-plane-job-backup-schedule',
        answer: 'phase4.py bak22: go-bak22 once the config its second Job queued is Done',
      }, HOLD_AGENT_MS)
    } catch (error) {
      log(`BAK-22 ${error}`)
      test.skip(true, `N/A — no L-x: nobody answered HOLD bak22 within ${HOLD_AGENT_MS / 60_000} minutes`)
    }
    test.skip(!go, 'NOT COVERED by the spec: the agent answered skip-bak22, and its L_BAK22= line is the verdict (NOT_COVERED and why, e.g. no config of today is Done yet, or FAIL)')

    // The agent read the config's row Done before it answered: a reading of the bucket later than the go lists its object.
    const goAt = Date.now()
    let read: any = null
    try {
      read = await pollUntil('BAK-22 bucket read', () => get('admin', '/v1/admin/backups'),
        (b) => b.readAt !== null && Date.parse(b.readAt) > goAt, (b) => `readAt=${b.readAt}`, READ_WITHIN_MS, 15_000)
    } catch (error) {
      if (!String(error).includes('BAK-22 bucket read: timed out')) {
        throw error
      }
      log(`BAK-22 ${error}`)
      test.skip(true, `NOT COVERED: readAt of GET /v1/admin/backups did not pass the go (${new Date(goAt).toISOString()}) within ${READ_WITHIN_MS / 60_000} minutes`)
    }
    test.skip(dayOf(new Date(read.readAt)) !== day, `NOT COVERED: the run crossed 00:00Z (readAt ${read.readAt})`)
    const backups = (read.items as any[]).filter((i) => i.kind === 'vm' && i.name === vmName)
    const configs = configOf(read)
    log(`BAK-22 readAt=${read.readAt} vm ${vmName}: ${itemShape(backups[0])}; config of ${clusterName}: ${itemShape(configs[0])}`)
    test.skip([...backups, ...configs].some((i) => i.health === 'Unknown'),
      `NOT COVERED: health Unknown at the read (vm: ${backups[0]?.reason}, config: ${configs[0]?.reason})`)
    // The checks are the two tests below, so that the config's health is measured whatever the VM's item shows.
    measured = { backups, configs }
  })

  // plan.md gives the config item's health to the spec for both rows; the rows of core.backups are the agent's L_BAK23=.
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/BackupHealthPolicy.cs (ForDisk) ·
  // titan-ops features/backup/design.md#cluster-backup · titan-ops features/backup/user-stories.md#bak-b03.
  test('BAK-22 and BAK-23 the cluster\'s config item is Ok at that read', async () => {
    test.skip(measured === null, 'NOT COVERED: the read before was not measured (N/A or NOT COVERED), and this one follows it')
    const { configs } = measured!
    log(`BAK-23 config item: ${itemShape(configs[0])}`)
    expect(configs.length, 'items of kind cluster with the cluster\'s name').toBe(1)
    expect(configs[0].takenAt).not.toBeNull()
    expect(configs[0].health).toBe('Ok')
  })

  // titan-ops features/backup/design.md#cluster-backup: the config asked after the VM's backup knows that VM.
  test('BAK-22 the VM\'s backup is in the bucket and the cluster\'s config was taken after it', async () => {
    test.skip(measured === null, 'NOT COVERED: the read before was not measured (N/A or NOT COVERED), and this one follows it')
    const { backups, configs } = measured!
    expect(backups.length, `items of kind vm named ${vmName}`).toBe(1)
    const [backup] = backups
    expect(backup.takenAt, 'the VM\'s backup row is Done: its object is in the bucket').not.toBeNull()
    expect(Date.parse(configs[0].takenAt), `the config (${configs[0].takenAt}) was taken after the VM's backup (${backup.takenAt})`)
      .toBeGreaterThan(Date.parse(backup.takenAt))
  })
})
