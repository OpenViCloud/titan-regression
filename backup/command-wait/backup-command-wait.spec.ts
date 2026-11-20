import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { cleanUp } from './clean-up'
import { hold } from './host-hold'
import { RUN, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, waitVm } from './fixtures'

// Case BAK-20 of plan.md (L-x; on prd only until titan-ops status/known-state.md#first-real-customer). A job of its own
// (run-module.sh … backup/command-wait …, job regression-command-wait-<label>): the backup module's ConfigMap takes only
// the files of backup/, so this one never runs with it, and the sequential lane never waits on the agent's step.
// The spec makes a VM of its own (no backup today), then logs HOLD bak20 {vmId, vmName, backupKey} and waits for the agent's
// `python3 phase4.py bak20` (README §Steps outside the runner): it creates a Job from CronJob
// control-plane-job-backup-schedule when the VM's vm.backup row of today is not there yet, answers go-bak20 once that row
// is Leased (psql SELECT on core.provider_commands, read only), and reads the snapshot's command row while the backup holds
// the VM (its L_BAK20= line is the SQL part's verdict). skip-bak20 is NOT COVERED with the reason on that line, among
// them the row's own: the VM's backup of today has already ended.

// OpenViCloud/titan-control-plane:Titan.Application/Options/RequestStuckOptions.cs (ThresholdMinutes = 15)
const STUCK_AFTER_MS = 15 * 60_000
// The runner's job ends after 90 minutes (OpenViCloud/titan-local-cluster:base/regression-runner/cronjob.yaml
// activeDeadlineSeconds 5400), the results copied before that: the test is capped at 75 minutes
// (test.describe.configure below) and afterAll, which deletes the VM, at 20, so only a worst case of both runs past it.
// Today's backup of every VM of a tenant queues in that tenant's backup lane, one at a time
// (titan-ops features/provider/design.md#tenant-lane): the VM's may wait behind the others before it is Leased.
const HOLD_BACKUP_MS = 35 * 60_000
// From the go to the snapshot's end: the rest of the backup (a few minutes for a small VM on dev), then the snapshot.
const SNAPSHOT_WITHIN_MS = 30 * 60_000

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ProviderCommand/Enums/BackupCommandKeys.cs (Vm: the UTC day, yyyyMMdd)
function backupKeyOf(vmId: string, at: Date): string {
  return `vm-backup-${vmId}-${at.toISOString().slice(0, 10).replace(/-/g, '')}`
}

function snapshotShape(s: any): string {
  return `status=${s.status} failure=${s.requestFailureReason}`
}

test.describe.serial('backup-command-wait', () => {
  test.describe.configure({ timeout: 75 * 60_000 })

  const vmName = `rg-bak20-${RUN}`
  let vmId = ''

  test.beforeAll(async ({ browser }) => {
    startLog('backup-command-wait')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    await cleanUp([
      ['vm', async () => {
        if (vmId !== '') {
          // Not while its snapshot still waits: a delete of a Snapshotting VM is refused.
          await waitVm('BAK-20 vm at rest', vmId, (v) => v.status !== 'Creating' && v.status !== 'Snapshotting' && v.status !== 'Starting')
          await deleteVmAndWait(vmId)
        }
      }],
      ['sessions', closeSessions],
    ])
  })

  async function readSnapshot(id: string): Promise<any> {
    const rows = await get('tenant', `/v1/tenant/vms/${vmId}/snapshots`) as any[]
    return rows.find((s) => s.id === id) ?? { status: 'Deleted', requestFailureReason: null }
  }

  // titan-ops features/backup/design.md#incus-backup · titan-ops features/provider/design.md#tenant-lane (each VM has one
  // leased command at a time, so a command waits while its VM backs up:
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ProviderCommand/ProviderCommand.cs ResourceId) ·
  // titan-ops architecture/resource-lifecycle.md#lost-and-stale ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/PendingRequestReader.cs (ListStuckAsync: a command
  // that waits while another command of its VM is Leased is not stuck) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VmSnapshots/CreateSnapshotEndpoint.cs (HandleAsync: 202 {snapshotId}) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Snapshots.cs (AddSnapshot: the VM is Snapshotting until the
  // create reports, then back to its Incus status) · titan-ops features/backup/user-stories.md#bak-b03.
  // "VM Running throughout" is read as: Running or Ready on every read, Snapshotting only between the POST and the
  // snapshot's end (its own status while it waits), never stopped, frozen or in error by the backup.
  test('BAK-20 a VM snapshot asked while the VM backs up waits Pending behind the backup, is not stuck, and ends Available', async () => {
    const network = await runNetwork()
    const { smallTier } = await envOf()
    vmId = await createVm(vmName, smallTier, network.id)
    await waitVm('BAK-20 vm running', vmId, (v) => runs(v))

    // The VM's status every 5 s from here to the end, beside the case's own reads.
    const seen: Array<{ at: number, status: string }> = []
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        try {
          const status = (await getVm(vmId)).status as string
          if (seen.length === 0 || seen[seen.length - 1].status !== status) {
            log(`BAK-20 vm status ${status}`)
          }
          seen.push({ at: Date.now(), status })
        } catch (error) {
          log(`BAK-20 vm read failed: ${error}`)
        }
        await sleep(5_000)
      }
    })()
    let postedAt = 0
    let endedAt = 0
    try {
      const backupKey = backupKeyOf(vmId, new Date())
      let go = false
      try {
        go = await hold('bak20', {
          vmId, vmName, backupKey, cronJob: 'control-plane-job-backup-schedule',
          answer: 'phase4.py bak20: go-bak20 once the vm.backup row of vmId is Leased',
        }, HOLD_BACKUP_MS)
      } catch (error) {
        log(`BAK-20 ${error}`)
        test.skip(true, `N/A — no L-x: nobody answered HOLD bak20 within ${HOLD_BACKUP_MS / 60_000} minutes`)
      }
      test.skip(!go, 'NOT COVERED: the agent answered skip-bak20 (its L_BAK20= line says why, e.g. the VM already has a backup today)')

      // Before the call: a sample read while the reply is on its way may already be Snapshotting.
      postedAt = Date.now()
      const reply = await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/snapshots`, { name: `rg-bak20s-${RUN}` }, newKey())
      expectStatus(reply, 202)
      expect(Object.keys(bodyOf(reply))).toEqual(['snapshotId'])
      const snapshotId = bodyOf(reply).snapshotId as string
      log(`BAK-20 snapshot ${snapshotId} posted while the backup ${backupKey} is Leased`)
      const first = await readSnapshot(snapshotId)
      log(`BAK-20 first read of the snapshot: ${snapshotShape(first)}`)
      expect(first.status, 'the snapshot waits behind the backup').toBe('Creating')

      let stuckReads = 0
      const ended = await pollUntil('BAK-20 snapshot', async () => {
        const snapshot = await readSnapshot(snapshotId)
        if (snapshot.status === 'Creating' && Date.now() - postedAt > STUCK_AFTER_MS + 60_000) {
          const stuck = await get('admin', '/v1/admin/requests/stuck') as any[]
          const listed = stuck.filter((r) => r.id === snapshotId)
          log(`BAK-20 +${Math.round((Date.now() - postedAt) / 1000)}s past the stuck threshold, still Creating: stuck rows of the snapshot ${JSON.stringify(listed)}`)
          expect(listed, 'a snapshot that waits behind its VM\'s backup is not stuck').toEqual([])
          stuckReads++
        }
        return snapshot
      }, (s) => s.status !== 'Creating', snapshotShape, SNAPSHOT_WITHIN_MS, 10_000)
      endedAt = Date.now()
      log(`BAK-20 snapshot ${snapshotShape(ended)} after ${Math.round((endedAt - postedAt) / 1000)} s`)
      expect(ended.status).toBe('Available')
      expect(ended.requestFailureReason ?? null).toBeNull()
      if (stuckReads === 0) {
        log(`BAK-20 NOT COVERED for the stuck part: the snapshot left Creating ${Math.round((endedAt - postedAt) / 1000)} s after the POST, before the stuck list is read, ${(STUCK_AFTER_MS + 60_000) / 60_000} minutes after the POST (the backup ended first)`)
        test.info().annotations.push({ type: 'note', description: 'stuck part not measured: the backup ended before the stuck threshold' })
      }
      await waitVm('BAK-20 vm back from Snapshotting', vmId, (v) => runs(v))
    } finally {
      sampling = false
      await sampler
    }

    const at = (s: { at: number, status: string }) => `${s.status}@${new Date(s.at).toISOString()}`
    log(`BAK-20 vm statuses (posted ${new Date(postedAt).toISOString()}, snapshot ended ${new Date(endedAt).toISOString()}): ${seen.filter((s, i) => i === 0 || seen[i - 1].status !== s.status).map(at).join(' ')}`)
    const off = seen.filter((s) => !(s.status === 'Running' || s.status === 'Ready'
      || (s.status === 'Snapshotting' && s.at >= postedAt && s.at <= endedAt + 30_000)))
    expect(off.map(at), 'the VM runs throughout: Running or Ready, Snapshotting only while its snapshot waits').toEqual([])
  })
})
