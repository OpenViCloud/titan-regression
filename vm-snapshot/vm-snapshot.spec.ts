import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, log, newKey, pollUntil, startLog } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, waitVm } from './fixtures'

// Cases VMS-01..08 of plan.md, plus ACT-02/ACT-03 for VM snapshots.

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/ValueObjects/TenantQuota.cs DefaultMaxVmSnapshotsPerVm — no API reads the cap
const MAX_SNAPSHOTS_PER_VM = 3

function snapshotShape(s: any): string {
  return `existence=${s.currentExistence} desired=${s.desiredExistence} transition=${s.transition} failure=${s.requestFailureReason}`
}

test.describe.serial('vm-snapshot', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  const vmName = `rg-snapvm-${RUN}`
  let vmId = ''
  const snapshots: Record<string, string> = {}

  function path(): string {
    return `/v1/tenant/vms/${vmId}/snapshots`
  }

  async function readSnapshot(id: string): Promise<any> {
    const reply = await call('tenant', 'GET', path())
    if (reply.status === 404) {
      return { currentExistence: 'Deleted' }
    }
    expectStatus(reply, 200)
    const row = (bodyOf(reply) as any[]).find((s) => s.id === id)
    if (row === undefined) {
      return { currentExistence: 'Deleted' }
    }
    return row
  }

  async function waitSnapshot(label: string, id: string, done: (s: any) => boolean): Promise<any> {
    return pollUntil(label, () => readSnapshot(id), done, snapshotShape)
  }

  async function createSnapshot(label: string): Promise<string> {
    const reply = await call('tenant', 'POST', path(), { name: `rg-${label}-${RUN}` }, newKey())
    expectStatus(reply, 202)
    expect(Object.keys(bodyOf(reply))).toEqual(['snapshotId'])
    const id = bodyOf(reply).snapshotId as string
    snapshots[label] = id
    return id
  }

  function exists(s: any): boolean {
    return s.currentExistence === 'Exists' && s.transition === null
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('vm-snapshot')
    useBrowser(browser)
    const { smallTier } = await envOf()
    const networkId = (await runNetwork()).id
    vmId = await createVm(vmName, smallTier, networkId)
    await waitVm('snapshot VM runs', vmId, runs)
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    if (vmId !== '') {
      await pollUntil('no snapshot in progress', async () => {
        const reply = await call('tenant', 'GET', path())
        if (reply.status !== 200) {
          return []
        }
        return bodyOf(reply) as any[]
      }, (rows) => rows.every((s) => s.transition === null), (rows) => rows.map(snapshotShape).join(' | '))
      await deleteVmAndWait(vmId)
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VmSnapshots/CreateSnapshotEndpoint.cs HandleAsync
  test('VMS-01 a snapshot of a running VM is 202 {snapshotId}, then Exists', async () => {
    const id = await createSnapshot('s1')
    await waitSnapshot('VMS-01', id, exists)
    const name = `rg-s1-${RUN}`
    const actions = await activityOf(name)
    log(`ACT-02 vm snapshot ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm_snapshot.create_requested')).toBe(1)
    expect(countOf(actions, 'vm_snapshot.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs EnsureSnapshottable — Running, Ready, Stopped or Frozen
  test('VMS-02 a snapshot of a stopped VM Exists too', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/stop`), 202)
    await waitVm('VMS-02 stop', vmId, (v) => v.currentState === 'Stopped' && v.transition === null)
    const id = await createSnapshot('s2')
    await waitSnapshot('VMS-02', id, exists)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/Tenant.cs EnsureCanCreateVmSnapshot; a delete asked stops counting
  // (titan-ops features/vm/design.md#vm-snapshot-counting)
  test('VMS-03 the snapshot past the cap is 422 VM_SNAPSHOT_QUOTA_EXCEEDED; a delete frees the slot', async () => {
    const third = await createSnapshot('s3')
    await waitSnapshot('VMS-03 third', third, exists)
    expect(Object.keys(snapshots).length).toBe(MAX_SNAPSHOTS_PER_VM)
    expectError(await call('tenant', 'POST', path(), { name: `rg-s4-${RUN}` }, newKey()), 422, 'VM_SNAPSHOT_QUOTA_EXCEEDED')
    expectStatus(await call('tenant', 'DELETE', `${path()}/${third}`), 202)
    const fourth = await createSnapshot('s4')
    await waitSnapshot('VMS-03 fourth', fourth, exists)
    await waitSnapshot('VMS-03 third deleted', third, (s) => s.currentExistence === 'Deleted')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VmSnapshots/RevertSnapshotEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/UpdateVmSnapshotStatusCommandHandler.cs HandleAsync (snapshot.MarkReverted())
  test('VMS-04 revert is 202, Reverting then settled, outcome reverted, desired unchanged', async () => {
    const before = await getVm(vmId)
    const reply = await call('tenant', 'POST', `${path()}/${snapshots.s1}/revert`)
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    const right = await readSnapshot(snapshots.s1)
    log(`VMS-04 right after revert: ${snapshotShape(right)}`)
    expect(right.transition).toBe('Reverting')
    await waitSnapshot('VMS-04', snapshots.s1, exists)
    const after = await getVm(vmId)
    expect(after.desiredState).toBe(before.desiredState)
    const actions = await activityOf(`rg-s1-${RUN}`)
    expect(countOf(actions, 'vm_snapshot.revert_requested')).toBe(1)
    expect(countOf(actions, 'vm_snapshot.reverted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs RequestDelete (a snapshot the VM holds BlocksVmDelete ⇒ VM_SNAPSHOT_IN_PROGRESS; the snapshot is the VM's child entity)
  test('VMS-05 deleting the VM while a snapshot is being made is 422 VM_SNAPSHOT_IN_PROGRESS', async () => {
    expectStatus(await call('tenant', 'DELETE', `${path()}/${snapshots.s4}`), 202)
    await waitSnapshot('VMS-05 free a slot', snapshots.s4, (s) => s.currentExistence === 'Deleted')
    const id = await createSnapshot('s5')
    expectError(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`), 422, 'VM_SNAPSHOT_IN_PROGRESS')
    await waitSnapshot('VMS-05 settles', id, exists)
    expect((await getVm(vmId)).desiredExistence).toBe('Exists')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/DeleteVmSnapshotCommandHandler.cs HandleAsync (alreadyRequestedOrDone) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VmSnapshots/DeleteSnapshotEndpoint.cs HandleAsync
  test('VMS-06 delete a snapshot is 202, then Deleted; a repeat is 202 and records nothing', async () => {
    expectStatus(await call('tenant', 'DELETE', `${path()}/${snapshots.s2}`), 202)
    await waitSnapshot('VMS-06', snapshots.s2, (s) => s.currentExistence === 'Deleted')
    expectStatus(await call('tenant', 'DELETE', `${path()}/${snapshots.s2}`), 202)
    const actions = await activityOf(`rg-s2-${RUN}`)
    expect(countOf(actions, 'vm_snapshot.delete_requested')).toBe(1)
    expect(countOf(actions, 'vm_snapshot.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs RequireSnapshot (a snapshot the VM does not hold answers 404; the snapshot is the VM's child entity)
  test('VMS-08 a snapshot id the VM does not have is 404 VM_SNAPSHOT_NOT_FOUND', async () => {
    expectError(await call('tenant', 'DELETE', `${path()}/${randomUUID()}`), 404, 'VM_SNAPSHOT_NOT_FOUND')
    expectError(await call('tenant', 'POST', `${path()}/${randomUUID()}/revert`), 404, 'VM_SNAPSHOT_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/UpdateVmStatusCommandHandler.cs HandleAsync (case Deleted: vm.MarkDeleted() takes the VM's snapshots along) — the VM's Deleted report marks its snapshots Deleted
  test('VMS-07 deleting the VM takes its remaining snapshots to Deleted', async () => {
    await deleteVmAndWait(vmId)
    for (const label of ['s1', 's5']) {
      const snapshot = await readSnapshot(snapshots[label])
      log(`VMS-07 ${label}: ${snapshotShape(snapshot)}`)
      expect(snapshot.currentExistence).toBe('Deleted')
    }
    vmId = ''
  })
})
