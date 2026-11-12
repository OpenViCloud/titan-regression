import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import { closeSessions, useBrowser } from './auth'
import { OBSERVED_WITHIN_MS, bodyOf, call, expectStatus, get, log, newKey, pollUntil, sleep, startLog, type Reply } from './api'
import { cleanUp } from './clean-up'
import { RUN, createVm, deleteVmAndWait, envOf, getVm, readVolume, runNetwork, runs, vmShape, volumeShape, waitVm, waitVolume } from './fixtures'

// Case ADM-15 of plan.md (L-x; on prd only until titan-ops status/known-state.md#first-real-customer). A job of its own
// (run-module.sh … admin/stuck-requests …): the admin module's ConfigMap takes only the files of admin/, so this one never
// runs with it. The worker is stopped and started on two log lines, by run-module.sh when REGRESSION_WORKER_APPS names
// the worker's ArgoCD Applications, else, on dev only, by the agent outside the runner (on the release environment only
// the runner, under an approved L-x; nobody answers by hand there):
//   WORKER_STOP_WAIT  — turn off auto-sync of the worker's Application, scale the worker to 0, wait until no worker pod
//                       is left, then touch /work/adm-15/worker-stopped in this pod (or, on dev, /work/adm-15/skip: N/A at once);
//   WORKER_START_WAIT — scale the worker back, turn auto-sync back on, wait until the worker pod is Ready, then touch
//                       /work/adm-15/worker-started.
// ADM15_GAVE_UP means the spec stopped waiting for WORKER_STOP_WAIT's answer: the worker must be (or be put) back.
// While the worker is down nothing of any tenant reaches Incus: no other module may run.
const MARKERS = '/work/adm-15'
const STOPPED = `${MARKERS}/worker-stopped`
const STARTED = `${MARKERS}/worker-started`
const SKIP = `${MARKERS}/skip`
const GAVE_UP = `${MARKERS}/gave-up`

// OpenViCloud/titan-control-plane:Titan.Application/Options/RequestStuckOptions.cs (ThresholdMinutes = 15)
const STUCK_AFTER_MS = 15 * 60_000

// VmStatus/VolumeStatus transient values: everything else (the Incus words, NotFound, Failed, Deleted) is at rest.
function vmAtRest(v: any): boolean {
  return v.status !== 'Creating' && v.status !== 'Starting' && v.status !== 'Stopping' && v.status !== 'Deleting' && v.status !== 'Snapshotting'
}

function volumeAtRest(v: any): boolean {
  return v.status !== 'Creating' && v.status !== 'Attaching' && v.status !== 'Detaching' && v.status !== 'Deleting'
}

async function waitForFile(paths: string[], timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = paths.find((p) => fs.existsSync(p))
    if (found !== undefined) {
      return found
    }
    await sleep(5_000)
  }
  return null
}

async function waitWorkerStarted(when: string): Promise<void> {
  log(`WORKER_START_WAIT (${when}) scale deploy/incus-worker (and deploy/incus-worker-inventory where it exists) back, turn auto-sync on, wait for the pods Ready, then touch ${STARTED}`)
  const found = await waitForFile([STARTED], 15 * 60_000)
  if (found === null) {
    throw new Error(`the agent never touched ${STARTED}: the incus-worker may still be at 0 replicas`)
  }
  log(`ADM-15 worker started (${when})`)
}

test.describe.serial('admin-worker-down', () => {
  test.describe.configure({ timeout: 80 * 60_000 })

  let stopVmId = ''
  let otherVmId = ''
  let volumeId = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('admin-worker-down')
    useBrowser(browser)
    fs.mkdirSync(MARKERS, { recursive: true })
  })

  test.afterAll(async () => {
    test.setTimeout(40 * 60_000)
    await cleanUp([
      ['worker back', async () => {
        const stoppedHere = fs.existsSync(STOPPED) && !fs.existsSync(GAVE_UP)
        if (stoppedHere && !fs.existsSync(STARTED)) {
          await waitWorkerStarted('afterAll')
        }
      }],
      ['volume', async () => {
        if (volumeId === '') {
          return
        }
        const volume = await waitVolume('volume at rest', volumeId, volumeAtRest)
        if (volume.status === 'Deleted') {
          return
        }
        if (volume.currentAttachedVmId !== null) {
          expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/detach`), 202)
          await waitVolume('volume detached for cleanup', volumeId, (v) => v.currentAttachedVmId === null && volumeAtRest(v))
        }
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`), 202)
        await waitVolume('volume deleted', volumeId, (v) => v.status === 'Deleted')
      }],
      ['stopped vm', async () => {
        if (stopVmId !== '') {
          await waitVm('stopped vm at rest', stopVmId, vmAtRest)
          await deleteVmAndWait(stopVmId)
        }
      }],
      ['vm of the volume', async () => {
        if (otherVmId !== '') {
          await waitVm('vm of the volume at rest', otherVmId, vmAtRest)
          await deleteVmAndWait(otherVmId)
        }
      }],
      ['sessions', closeSessions],
    ])
  })

  // titan-ops architecture/resource-lifecycle.md#lost-and-stale · OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/PendingRequestReader.cs
  // (ListStuckAsync: core.pending_requests joined to the command row by key; resource 'vm' / 'volume', kind the request kind) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/ProviderCommands/ProviderCommandQueue.cs (VmStopKey, VolumeDetachKey) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Enums/VmStatus.cs (Stopping) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Enums/VolumeStatus.cs
  // (Detaching) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Hosting/StuckRequestHealthCheck.cs (Evaluate: Degraded while the command is open) ·
  // OpenViCloud/titan-control-plane:Titan.Host/Program.cs (AddCheck<StuckRequestHealthCheck>, MapHealthChecks("/healthz/reconcilers"))
  test('ADM-15 with the worker stopped, a VM stop and a volume detach are listed stuck with their command Pending; the worker back clears both', async () => {
    const network = await runNetwork()
    const { clusterId, smallTier, volumeOfferingId } = await envOf()
    stopVmId = await createVm(`rg-stuckvm-${RUN}`, smallTier, network.id)
    otherVmId = await createVm(`rg-stuckvm2-${RUN}`, smallTier, network.id)
    const created = await call('tenant', 'POST', '/v1/tenant/volumes',
      { name: `rg-stuckvol-${RUN}`, volumeOfferingId, clusterId, sizeGb: 1 }, newKey())
    expectStatus(created, 202)
    volumeId = bodyOf(created).volumeId
    await waitVm('ADM-15 vm to stop running', stopVmId, (v) => runs(v))
    await waitVm('ADM-15 vm of the volume running', otherVmId, (v) => runs(v))
    await waitVolume('ADM-15 volume exists', volumeId, (v) => v.status === 'Available')
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/attach`, { vmId: otherVmId }), 202)
    await waitVolume('ADM-15 volume attached', volumeId, (v) => v.currentAttachedVmId === otherVmId && v.status === 'Available')

    log(`WORKER_STOP_WAIT turn off auto-sync of the worker's Application, scale deploy/incus-worker (and deploy/incus-worker-inventory where it exists) to 0, wait until no worker pod is left, then touch ${STOPPED} (or ${SKIP}: no L-x)`)
    const answer = await waitForFile([STOPPED, SKIP], 10 * 60_000)
    if (answer !== STOPPED) {
      fs.writeFileSync(GAVE_UP, '')
      log(`ADM15_GAVE_UP answer=${answer} — the incus-worker must run (scale it back if it was stopped)`)
    }
    test.skip(answer === SKIP, 'N/A — no L-x: the agent did not stop the incus-worker')
    test.skip(answer === null, 'N/A — no L-x: nobody answered WORKER_STOP_WAIT within 10 minutes')

    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${stopVmId}/stop`), 202)
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/detach`), 202)
    const askedAt = Date.now()
    // A worker still running would finish both within a lease poll and Incus's work: a minute later both still wait.
    await sleep(60_000)
    const vmWaiting = await getVm(stopVmId)
    const volumeWaiting = await readVolume(volumeId)
    log(`ADM-15 a minute after the requests: vm ${vmShape(vmWaiting)} · volume ${volumeShape(volumeWaiting)}`)
    expect(vmWaiting.status, 'the stop still waits: the worker is down').toBe('Stopping')
    expect(volumeWaiting.status, 'the detach still waits: the worker is down').toBe('Detaching')

    const mine = (rows: any[]) => rows.filter((r) => r.id === stopVmId || r.id === volumeId)
    const stuck = await pollUntil('ADM-15 both requests stuck',
      () => get('admin', '/v1/admin/requests/stuck') as Promise<any[]>,
      (rows) => mine(rows).length >= 2,
      (rows) => JSON.stringify(mine(rows)),
      STUCK_AFTER_MS + 8 * 60_000, 30_000)
    log(`ADM-15 stuck after ${Math.round((Date.now() - askedAt) / 1000)}s: ${JSON.stringify(mine(stuck))}`)
    const vmRows = stuck.filter((r) => r.id === stopVmId)
    const volumeRows = stuck.filter((r) => r.id === volumeId)
    expect(vmRows.length).toBe(1)
    expect(vmRows[0]).toMatchObject({ resource: 'vm', kind: 'Stop', commandStatus: 'Pending' })
    expect(volumeRows.length).toBe(1)
    expect(volumeRows[0]).toMatchObject({ resource: 'volume', kind: 'Detach', commandStatus: 'Pending' })
    const unhealthy: Reply = await call('anonymous', 'GET', '/healthz/reconcilers')
    log(`ADM-15 /healthz/reconcilers with the worker down: ${unhealthy.status} ${unhealthy.text.slice(0, 300)}`)
    expect(unhealthy.text.trim()).not.toBe('Healthy')

    await waitWorkerStarted('ADM-15')
    const stopped = await waitVm('ADM-15 vm stopped', stopVmId, (v) => v.status === 'Stopped')
    expect(['Deleting', 'Deleted']).not.toContain(stopped.status)
    await waitVolume('ADM-15 volume detached', volumeId, (v) => v.currentAttachedVmId === null && v.status === 'Available')
    await pollUntil('ADM-15 stuck rows gone',
      () => get('admin', '/v1/admin/requests/stuck') as Promise<any[]>,
      (rows) => mine(rows).length === 0,
      (rows) => JSON.stringify(mine(rows)))
    await pollUntil('ADM-15 /healthz/reconcilers Healthy again',
      () => call('anonymous', 'GET', '/healthz/reconcilers'),
      (reply) => reply.status === 200 && reply.text.trim() === 'Healthy',
      (reply) => `${reply.status} ${reply.text.slice(0, 200)}`,
      OBSERVED_WITHIN_MS, 15_000)
  })
})
