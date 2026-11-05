import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog, type Reply } from './api'
import { cleanUp } from './clean-up'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, vmShape, waitVm } from './fixtures'

// Cases VMS-01..13 and VMS-16 of plan.md, plus ACT-02/ACT-03 for VM snapshots (VMS-14, VMS-15, VMS-17 read the Incus
// host). VMS-12, VMS-10 and VMS-11 use a second VM, which VMS-11 deletes; VMS-16 deletes the module's VM and VMS-07
// reads what that delete did to its snapshots.

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/ValueObjects/TenantQuota.cs DefaultMaxVmSnapshotsPerVm — no API reads the cap
const MAX_SNAPSHOTS_PER_VM = 3

function snapshotShape(s: any): string {
  return `existence=${s.currentExistence} desired=${s.desiredExistence} transition=${s.transition} failure=${s.requestFailureReason}`
}

// Counts toward MaxVmSnapshotsPerVm as the server counts (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Entities/VmSnapshot.cs
// CountsTowardQuota): desired Exists and (Exists, or its create waits).
function countsTowardQuota(s: any): boolean {
  return s.desiredExistence === 'Exists' && (s.currentExistence === 'Exists' || s.transition === 'Creating')
}

test.describe.serial('vm-snapshot', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  const vmName = `rg-snapvm-${RUN}`
  let vmId = ''
  // The second VM of VMS-12, VMS-10 and VMS-11.
  let vmB = ''
  const snapshots: Record<string, string> = {}
  let tenantId = ''
  // The tenant's caps as the admin list shows them, restored in afterAll (VMS-12 changes one and restores it at once).
  let originalQuota: Record<string, number> | null = null

  function path(): string {
    return `/v1/tenant/vms/${vmId}/snapshots`
  }

  async function snapshotsOf(vm: string): Promise<any[]> {
    const reply = await call('tenant', 'GET', `/v1/tenant/vms/${vm}/snapshots`)
    if (reply.status === 404) {
      return []
    }
    expectStatus(reply, 200)
    return bodyOf(reply) as any[]
  }

  // The list leaves Deleted snapshots out (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmSnapshotRepository.cs FindByVmIdAsync).
  async function readSnapshotOf(vm: string, id: string): Promise<any> {
    const row = (await snapshotsOf(vm)).find((s) => s.id === id)
    if (row === undefined) {
      return { currentExistence: 'Deleted' }
    }
    return row
  }

  async function readSnapshot(id: string): Promise<any> {
    return readSnapshotOf(vmId, id)
  }

  async function adminRow(): Promise<any> {
    const row = (await get('admin', '/v1/tenants') as any[]).find((t) => t.id === tenantId)
    expect(row, `tenant ${tenantId} in GET /v1/tenants`).toBeDefined()
    return row
  }

  // PATCH needs maxVms and maxNetworks; every other cap left out is kept
  // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs UpdateQuotaRequest).
  async function setQuota(caps: Record<string, number>): Promise<void> {
    const row = await adminRow()
    const body = { maxVms: row.maxVms, maxNetworks: row.maxNetworks, ...caps }
    log(`quota PATCH ${JSON.stringify(body)}`)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, body), 204)
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
    tenantId = (await get('tenant', '/v1/tenant')).id
    const row = await adminRow()
    originalQuota = {
      maxVms: row.maxVms, maxNetworks: row.maxNetworks, maxVolumes: row.maxVolumes, maxVmSnapshotsPerVm: row.maxVmSnapshotsPerVm,
      maxVolumeSnapshotsPerVolume: row.maxVolumeSnapshotsPerVolume, maxFirewallRulesPerNetwork: row.maxFirewallRulesPerNetwork,
      maxPublicIpv6: row.maxPublicIpv6, maxSshKeys: row.maxSshKeys, maxLoadBalancers: row.maxLoadBalancers,
    }
    log(`quota before: ${JSON.stringify(originalQuota)}`)
    const { smallTier } = await envOf()
    const networkId = (await runNetwork()).id
    vmId = await createVm(vmName, smallTier, networkId)
    await waitVm('snapshot VM runs', vmId, runs)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = [
      ['quota', async () => {
        if (originalQuota !== null) {
          expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
        }
      }],
    ]
    for (const vm of [vmId, vmB]) {
      if (vm === '') {
        continue
      }
      // A create or revert in flight refuses the VM's delete (VM_SNAPSHOT_IN_PROGRESS); a waiting delete does not.
      steps.push([`vm ${vm}`, async () => {
        await pollUntil('no snapshot create or revert in progress', () => snapshotsOf(vm),
          (rows) => rows.every((s) => s.transition === null || s.transition === 'Deleting'), (rows) => rows.map(snapshotShape).join(' | '))
        await deleteVmAndWait(vm)
      }])
    }
    steps.push(['sessions', closeSessions])
    await cleanUp(steps)
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

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs EnsureHasRoom; a delete asked stops counting
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
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Entities/VmSnapshot.cs FinishOperation (Done of the revert)
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

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs Delete (a snapshot the VM holds BlocksVmDelete ⇒ VM_SNAPSHOT_IN_PROGRESS; the snapshot is the VM's child entity)
  test('VMS-05 deleting the VM while a snapshot is being made is 422 VM_SNAPSHOT_IN_PROGRESS', async () => {
    expectStatus(await call('tenant', 'DELETE', `${path()}/${snapshots.s4}`), 202)
    await waitSnapshot('VMS-05 free a slot', snapshots.s4, (s) => s.currentExistence === 'Deleted')
    const id = await createSnapshot('s5')
    expectError(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`), 422, 'VM_SNAPSHOT_IN_PROGRESS')
    await waitSnapshot('VMS-05 settles', id, exists)
    expect((await getVm(vmId)).desiredExistence).toBe('Exists')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/DeleteVmSnapshotCommandHandler.cs HandleAsync (IsDeletedOrDeleting) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VmSnapshots/DeleteSnapshotEndpoint.cs HandleAsync
  test('VMS-06 delete a snapshot is 202, then Deleted; a repeat is 202 and records nothing', async () => {
    expectStatus(await call('tenant', 'DELETE', `${path()}/${snapshots.s2}`), 202)
    await waitSnapshot('VMS-06', snapshots.s2, (s) => s.currentExistence === 'Deleted')
    expectStatus(await call('tenant', 'DELETE', `${path()}/${snapshots.s2}`), 202)
    const actions = await activityOf(`rg-s2-${RUN}`)
    expect(countOf(actions, 'vm_snapshot.delete_requested')).toBe(1)
    expect(countOf(actions, 'vm_snapshot.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs RequireVmSnapshot (a snapshot the VM does not hold answers 404; the snapshot is the VM's child entity)
  test('VMS-08 a snapshot id the VM does not have is 404 VM_SNAPSHOT_NOT_FOUND', async () => {
    expectError(await call('tenant', 'DELETE', `${path()}/${randomUUID()}`), 404, 'VM_SNAPSHOT_NOT_FOUND')
    expectError(await call('tenant', 'POST', `${path()}/${randomUUID()}/revert`), 404, 'VM_SNAPSHOT_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/CreateVmSnapshotCommandHandler.cs HandleAsync
  // (TenantQuotaGate.EnsureHasRoom before vm.AddSnapshot) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs AddSnapshot
  // (EnsureSnapshottable ⇒ VM_INVALID_STATUS) · OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs
  // EnsureHasRoom (count >= cap: a cap of 0 refuses the first) — titan-ops architecture/code-structure.md#quota-gate
  test('VMS-12 with maxVmSnapshotsPerVm 0, a snapshot of a VM not yet Running is 422 VM_SNAPSHOT_QUOTA_EXCEEDED, not VM_INVALID_STATUS', async () => {
    const original = (await adminRow()).maxVmSnapshotsPerVm as number
    const { smallTier } = await envOf()
    const networkId = (await runNetwork()).id
    const name = `rg-s12-${RUN}`
    let reply: Reply | undefined
    let right: any
    await setQuota({ maxVmSnapshotsPerVm: 0 })
    try {
      vmB = await createVm(`rg-snapvmb-${RUN}`, smallTier, networkId)
      reply = await call('tenant', 'POST', `/v1/tenant/vms/${vmB}/snapshots`, { name }, newKey())
      right = await getVm(vmB)
    } finally {
      await setQuota({ maxVmSnapshotsPerVm: original })
    }
    log(`VMS-12 VM right after the snapshot request: ${vmShape(right)}`)
    if (runs(right) && right.transition === null) {
      test.info().annotations.push({ type: 'note', description: 'the VM was already Running: the order of the two checks was not measured' })
    }
    expectError(reply!, 422, 'VM_SNAPSHOT_QUOTA_EXCEEDED')
    expect(await snapshotsOf(vmB)).toEqual([])
    expect(countOf(await activityOf(name), 'vm_snapshot.create_requested')).toBe(0)
    await waitVm('VMS-12 second VM runs', vmB, (v) => runs(v) && v.transition === null)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs RequireVmSnapshot (the snapshot is the VM's
  // child entity: a snapshot of another VM answers like a missing one) · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/RevertVmSnapshotCommandHandler.cs
  // and OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/DeleteVmSnapshotCommandHandler.cs HandleAsync — titan-ops architecture/code-structure.md#child-entity
  test("VMS-10 another VM's snapshot through this VM's route is 404 VM_SNAPSHOT_NOT_FOUND on revert and delete", async () => {
    const reply = await call('tenant', 'POST', `/v1/tenant/vms/${vmB}/snapshots`, { name: `rg-sb1-${RUN}` }, newKey())
    expectStatus(reply, 202)
    const snapshotOfB = bodyOf(reply).snapshotId as string
    snapshots.b1 = snapshotOfB
    await pollUntil('VMS-10 snapshot of B', () => readSnapshotOf(vmB, snapshotOfB), exists, snapshotShape)
    expectError(await call('tenant', 'POST', `${path()}/${snapshotOfB}/revert`), 404, 'VM_SNAPSHOT_NOT_FOUND')
    expectError(await call('tenant', 'DELETE', `${path()}/${snapshotOfB}`), 404, 'VM_SNAPSHOT_NOT_FOUND')
    const after = await readSnapshotOf(vmB, snapshotOfB)
    log(`VMS-10 snapshot of B after: ${snapshotShape(after)}`)
    expect(after.transition).toBeNull()
    expect(after.desiredExistence).toBe('Exists')
    expect(after.currentExistence).toBe('Exists')
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Entities/VmSnapshot.cs BlocksVmDelete (a waiting delete does not block),
  // EndWithItsVm, FinishOperation (IsDeleted: a later report records nothing) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs
  // Delete, FinishOperation · OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/VmReports.cs FinishOperationAsync
  // (the snapshots waiting on their delete, read before the call) — titan-ops architecture/intent-and-observation.md#terminal-state-absorbs
  test('VMS-11 a VM deleted while its only snapshot is being deleted: 202, both Deleted, one vm_snapshot.deleted', async () => {
    const id = snapshots.b1
    const name = `rg-sb1-${RUN}`
    const counted = (await snapshotsOf(vmB)).filter(countsTowardQuota)
    expect(counted.map((s) => s.id)).toEqual([id])
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmB}/snapshots/${id}`), 202)
    const reply = await call('tenant', 'DELETE', `/v1/tenant/vms/${vmB}`)
    const snapshotThen = await readSnapshotOf(vmB, id)
    log(`VMS-11 snapshot when the VM delete was answered: ${snapshotShape(snapshotThen)}`)
    expectStatus(reply, 202)
    await waitVm('VMS-11 VM deleted', vmB, (v) => v.currentExistence === 'Deleted')
    await pollUntil('VMS-11 snapshot deleted', () => readSnapshotOf(vmB, id), (s) => s.currentExistence === 'Deleted', snapshotShape)
    // The report that came second may still be on its way; it must record nothing.
    await sleep(20_000)
    const actions = await activityOf(name)
    log(`VMS-11 ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm_snapshot.delete_requested')).toBe(1)
    expect(countOf(actions, 'vm_snapshot.deleted')).toBe(1)
    vmB = ''
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/RevertVmSnapshotCommandHandler.cs HandleAsync
  // (alreadyReverting: answered like the first, nothing recorded, nothing sent) — titan-ops architecture/resource-lifecycle.md#repeat
  test('VMS-13 a revert repeated while Reverting is 202 and records one request and one outcome', async () => {
    const id = snapshots.s5
    const name = `rg-s5-${RUN}`
    await waitSnapshot('VMS-13 at rest', id, exists)
    expectStatus(await call('tenant', 'POST', `${path()}/${id}/revert`), 202)
    const right = await readSnapshot(id)
    log(`VMS-13 before the repeat: ${snapshotShape(right)}`)
    const raced = right.transition === 'Reverting'
    if (raced) {
      const repeat = await call('tenant', 'POST', `${path()}/${id}/revert`)
      expectStatus(repeat, 202)
      expect(repeat.text).toBe('')
    }
    await waitSnapshot('VMS-13 settles', id, exists)
    test.skip(!raced, 'the revert had already ended before the repeat could be sent: this lap measures nothing (CC-10 measures the rule)')
    const actions = await activityOf(name)
    log(`VMS-13 ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm_snapshot.revert_requested')).toBe(1)
    expect(countOf(actions, 'vm_snapshot.reverted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs SnapshotQuotaUsage · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VmSnapshot/CreateVmSnapshotCommandHandler.cs
  // HandleAsync (ComputeOwnership.RequireVmForUpdateAsync, then TenantQuotaGate) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmRepository.cs
  // FindByIdForUpdateAsync — titan-ops features/vm/design.md#vm-snapshot-counting
  test('VMS-09 two snapshots asked at once for the last slot: one 202, one 422 VM_SNAPSHOT_QUOTA_EXCEEDED, the VM holds the cap', async () => {
    const cap = (await adminRow()).maxVmSnapshotsPerVm as number
    log(`VMS-09 cap ${cap}`)
    expect(cap, 'the race needs a cap of at least 1').toBeGreaterThan(0)
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/start`), 202)
    await waitVm('VMS-09 VM runs', vmId, (v) => runs(v) && v.transition === null)
    await pollUntil('VMS-09 nothing waits', () => snapshotsOf(vmId), (rows) => rows.every((s) => s.transition === null),
      (rows) => rows.map(snapshotShape).join(' | '))
    let counted = (await snapshotsOf(vmId)).filter(countsTowardQuota).length
    let i = 0
    while (counted < cap - 1) {
      const id = await createSnapshot(`s9f${i}`)
      await waitSnapshot(`VMS-09 fill ${i}`, id, exists)
      counted++
      i++
    }
    expect((await snapshotsOf(vmId)).filter(countsTowardQuota).length).toBe(cap - 1)
    const [first, second] = await Promise.all([
      call('tenant', 'POST', path(), { name: `rg-s9x-${RUN}` }, newKey()),
      call('tenant', 'POST', path(), { name: `rg-s9y-${RUN}` }, newKey()),
    ])
    log(`VMS-09 answers: ${first.status} ${first.text.slice(0, 200)} | ${second.status} ${second.text.slice(0, 200)}`)
    expect([first.status, second.status].sort()).toEqual([202, 422])
    const won = first.status === 202 ? first : second
    const lost = first.status === 202 ? second : first
    expectError(lost, 422, 'VM_SNAPSHOT_QUOTA_EXCEEDED')
    expect(Object.keys(bodyOf(won))).toEqual(['snapshotId'])
    snapshots.s9 = bodyOf(won).snapshotId
    await waitSnapshot('VMS-09 winner', snapshots.s9, exists)
    const rows = await snapshotsOf(vmId)
    log(`VMS-09 snapshots after: ${rows.map((s) => `${s.name}:${snapshotShape(s)}`).join(' | ')}`)
    expect(rows.length).toBe(cap)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs AddSnapshot (EnsureSnapshottable ⇒ EnsureNoStopOrDeleteWaiting:
  // VM_INVALID_STATUS) — titan-ops features/vm/design.md#conflict-and-delete-wins
  test('VMS-16 a snapshot asked while the VM is Stopping or Deleting is 422 VM_INVALID_STATUS; stop and delete still end', async () => {
    // Room under the cap first: VMS-09 left the VM at it.
    expectStatus(await call('tenant', 'DELETE', `${path()}/${snapshots.s9}`), 202)
    await waitSnapshot('VMS-16 free a slot', snapshots.s9, (s) => s.currentExistence === 'Deleted')
    await waitVm('VMS-16 VM runs', vmId, (v) => runs(v) && v.transition === null)
    const skipped: string[] = []

    const stopName = `rg-s16a-${RUN}`
    const beforeStop = (await snapshotsOf(vmId)).map((s) => s.id).sort()
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/stop`), 202)
    const stopping = await getVm(vmId)
    log(`VMS-16 stop lap: ${vmShape(stopping)}`)
    if (stopping.transition === 'Stopping') {
      expectError(await call('tenant', 'POST', path(), { name: stopName }, newKey()), 422, 'VM_INVALID_STATUS')
      expect((await snapshotsOf(vmId)).map((s) => s.id).sort()).toEqual(beforeStop)
    } else {
      skipped.push('stop lap: the stop had already ended before the snapshot could be asked')
    }
    await waitVm('VMS-16 stopped', vmId, (v) => v.currentState === 'Stopped' && v.transition === null)
    expect(countOf(await activityOf(stopName), 'vm_snapshot.create_requested')).toBe(0)

    const deleteName = `rg-s16b-${RUN}`
    const beforeDelete = (await snapshotsOf(vmId)).map((s) => s.id).sort()
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`), 202)
    const deleting = await getVm(vmId)
    log(`VMS-16 delete lap: ${vmShape(deleting)}`)
    if (deleting.transition === 'Deleting') {
      expectError(await call('tenant', 'POST', path(), { name: deleteName }, newKey()), 422, 'VM_INVALID_STATUS')
      expect((await snapshotsOf(vmId)).map((s) => s.id).sort()).toEqual(beforeDelete)
    } else {
      skipped.push('delete lap: the delete had already ended before the snapshot could be asked')
    }
    await waitVm('VMS-16 deleted', vmId, (v) => v.currentExistence === 'Deleted')
    expect(countOf(await activityOf(deleteName), 'vm_snapshot.create_requested')).toBe(0)

    for (const reason of skipped) {
      log(`VMS-16 skipped ${reason}`)
      test.info().annotations.push({ type: 'skipped lap', description: reason })
    }
    test.skip(skipped.length === 2, `both laps skipped: ${skipped.join('; ')}`)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs FinishOperation (the delete's Done takes the VM's snapshots along) — the VM's
  // delete report marks its snapshots Deleted. The delete is VMS-16's; deleteVmAndWait only waits when VMS-16 did not send it.
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
