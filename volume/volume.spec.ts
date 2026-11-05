import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog, type Reply } from './api'
import { cleanUp } from './clean-up'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, readVolume, runNetwork, runs, volumeShape, waitVm, waitVolume } from './fixtures'

// Cases VOL-01..10, VOL-12..17, VOL-19 and VOL-20 of plan.md, plus ACT-02 for volumes and volume snapshots (VOL-11 and
// VOL-18 read the Incus host). Volumes: A (VOL-01..08), B never attached (VOL-04, VOL-12, VOL-13), the restored one
// (VOL-06, the other volume of VOL-13, deleted in VOL-14), C (VOL-15, VOL-16, VOL-19, VOL-17); VOL-10 fills the cap,
// VOL-09 deletes the VM.

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/ValueObjects/TenantQuota.cs DefaultMaxVolumes, DefaultMaxVolumeSnapshotsPerVolume — no API reads the caps
const MAX_VOLUMES = 10
const MAX_SNAPSHOTS_PER_VOLUME = 3

function snapshotShape(s: any): string {
  return `existence=${s.currentExistence} desired=${s.desiredExistence} transition=${s.transition} failure=${s.requestFailureReason}`
}

function settled(v: any): boolean {
  return v.currentExistence === 'Exists' && v.transition === null
}

// Counts toward MaxVolumeSnapshotsPerVolume as the server counts (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Entities/VolumeSnapshot.cs
// CountsTowardQuota): desired Exists and (Exists, or its create waits).
function countsTowardQuota(s: any): boolean {
  return s.desiredExistence === 'Exists' && (s.currentExistence === 'Exists' || s.transition === 'Creating')
}

// The feed holds the 50 newest rows (OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/ActivityEvent/ListActivityEventsQueryHandler.cs
// MaxLimit), so a volume whose older rows may have left the window is counted by the rows that appeared since `before`.
async function feedIds(): Promise<Set<string>> {
  const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ id: string }>
  return new Set(rows.map((r) => r.id))
}

async function newActionsOf(before: Set<string>, resourceName: string): Promise<string[]> {
  const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ id: string, action: string, resourceName: string }>
  return rows.filter((r) => !before.has(r.id) && r.resourceName === resourceName).map((r) => r.action)
}

test.describe.serial('volume', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  const made: string[] = []
  let vmId = ''
  let volumeA = ''
  let volumeB = ''
  let restored = ''
  let volumeC = ''
  let snapshotOfC = ''
  const snapshotsOfA: string[] = []
  let tenantId = ''
  // The tenant's caps as the admin list shows them, restored in afterAll (VOL-15, VOL-16 change one and restore it at once).
  let originalQuota: Record<string, number> | null = null

  async function createVolume(label: string): Promise<string> {
    const { clusterId, volumeOfferingId } = await envOf()
    const reply = await call('tenant', 'POST', '/v1/tenant/volumes',
      { name: `rg-${label}-${RUN}`, volumeOfferingId, clusterId, sizeGb: 1 }, newKey())
    expectStatus(reply, 202)
    expect(Object.keys(bodyOf(reply))).toEqual(['volumeId'])
    const id = bodyOf(reply).volumeId as string
    made.push(id)
    return id
  }

  async function snapshotsOf(volumeId: string): Promise<any[]> {
    return await get('tenant', `/v1/tenant/volumes/${volumeId}/snapshots`) as any[]
  }

  // The list leaves Deleted snapshots out (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VolumeSnapshotRepository.cs FindByVolumeIdAsync).
  async function readSnapshot(volumeId: string, id: string): Promise<any> {
    const row = (await snapshotsOf(volumeId)).find((s) => s.id === id)
    if (row === undefined) {
      return { currentExistence: 'Deleted' }
    }
    return row
  }

  async function createSnapshot(volumeId: string, name: string): Promise<string> {
    const reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/snapshots`, { name }, newKey())
    expectStatus(reply, 202)
    expect(Object.keys(bodyOf(reply))).toEqual(['snapshotId'])
    return bodyOf(reply).snapshotId as string
  }

  async function deleteVolumeAndWait(id: string): Promise<void> {
    const volume = await waitVolume(`volume ${id} at rest`, id, (v) => v.transition === null || v.currentExistence === 'Deleted')
    if (volume.currentExistence === 'Deleted') {
      return
    }
    if (volume.currentAttachedVmId !== null) {
      expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${id}/detach`), 202)
      await waitVolume('detached for cleanup', id, (v) => v.currentAttachedVmId === null && v.transition === null)
    }
    const snaps = await snapshotsOf(id)
    for (const snap of snaps) {
      if (snap.desiredExistence === 'Exists') {
        await pollUntil('snapshot at rest', () => readSnapshot(id, snap.id), (s) => s.transition === null, snapshotShape)
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${id}/snapshots/${snap.id}`), 202)
      }
      await pollUntil('snapshot deleted', () => readSnapshot(id, snap.id), (s) => s.currentExistence === 'Deleted', snapshotShape)
    }
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${id}`), 202)
    await waitVolume('volume deleted', id, (v) => v.currentExistence === 'Deleted')
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

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('volume')
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
    vmId = await createVm(`rg-volvm-${RUN}`, smallTier, networkId)
    await waitVm('volume VM runs', vmId, runs)
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
    for (const id of made) {
      steps.push([`volume ${id}`, () => deleteVolumeAndWait(id)])
    }
    steps.push(['vm', async () => {
      if (vmId !== '') {
        await deleteVmAndWait(vmId)
      }
    }])
    steps.push(['sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/CreateVolumeEndpoint.cs HandleAsync
  test('VOL-01 a volume is 202 {volumeId}, then Exists and not attached', async () => {
    volumeA = await createVolume('vola')
    const volume = await waitVolume('VOL-01', volumeA, settled)
    expect(volume.currentAttachedVmId).toBeNull()
    const actions = await activityOf(`rg-vola-${RUN}`)
    log(`ACT-02 volume rg-vola-${RUN}: ${actions.join(', ')}`)
    expect(countOf(actions, 'volume.create_requested')).toBe(1)
    expect(countOf(actions, 'volume.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/CreateVolumeCommandHandler.cs HandleAsync (VOLUME_OFFERING_NOT_FOUND)
  test('VOL-02 an unknown offering is 404 VOLUME_OFFERING_NOT_FOUND and makes no row', async () => {
    const { clusterId } = await envOf()
    const name = `rg-volx-${RUN}`
    expectError(await call('tenant', 'POST', '/v1/tenant/volumes', { name, volumeOfferingId: 'rg-none', clusterId, sizeGb: 1 }, newKey()),
      404, 'VOLUME_OFFERING_NOT_FOUND')
    const rows = await get('tenant', '/v1/tenant/volumes') as any[]
    expect(rows.some((v) => v.name === name)).toBe(false)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/CreateVolumeValidator.cs CreateVolumeValidator (Name NotEmpty and
  // MaximumLength(Volume.NameMaxLength), 100, from OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs; SizeGb GreaterThan(0))
  // — titan-ops features/volume/design.md#volume-routes
  test('VOL-20 size 0, size -1, an empty name and a 101-character name are each 400 VALIDATION_ERROR, no row', async () => {
    const { clusterId, volumeOfferingId } = await envOf()
    const longName = 'rg-' + 'x'.repeat(98)
    expect(longName.length).toBe(101)
    const bodies = [
      { name: `rg-vol20a-${RUN}`, volumeOfferingId, clusterId, sizeGb: 0 },
      { name: `rg-vol20b-${RUN}`, volumeOfferingId, clusterId, sizeGb: -1 },
      { name: '', volumeOfferingId, clusterId, sizeGb: 1 },
      { name: longName, volumeOfferingId, clusterId, sizeGb: 1 },
    ]
    for (const body of bodies) {
      expectError(await call('tenant', 'POST', '/v1/tenant/volumes', body, newKey()), 400, 'VALIDATION_ERROR')
    }
    const names = new Set(bodies.map((b) => b.name))
    const rows = await get('tenant', '/v1/tenant/volumes') as any[]
    expect(rows.filter((v) => names.has(v.name)).map((v) => v.name)).toEqual([])
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/AttachVolumeEndpoint.cs HandleAsync — 202, no body;
  // attachment is read from used_by (titan-ops features/volume/design.md#attachment-from-used-by) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs Delete (IsInUse ⇒ VOLUME_INVALID_STATE) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/DeleteVolumeCommandHandler.cs HandleAsync (the refusal stages nothing)
  test('VOL-03 attach to a running VM is 202 with no body, then attached; deleting it attached is 422 VOLUME_INVALID_STATE', async () => {
    const reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/attach`, { vmId })
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    const volume = await waitVolume('VOL-03', volumeA, (v) => v.currentAttachedVmId === vmId && v.transition === null)
    expect(volume.currentAttachedElsewhere).toBe(false)
    const actions = await activityOf(`rg-vola-${RUN}`)
    expect(countOf(actions, 'volume.attach_requested')).toBe(1)
    expect(countOf(actions, 'volume.attached')).toBe(1)

    expectError(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}`), 422, 'VOLUME_INVALID_STATE')
    const after = await readVolume(volumeA)
    log(`VOL-03 after the refused delete: ${volumeShape(after)}`)
    expect(after.currentAttachedVmId).toBe(vmId)
    expect(after.desiredExistence).toBe('Exists')
    expect(after.transition).toBeNull()
    expect(countOf(await activityOf(`rg-vola-${RUN}`), 'volume.delete_requested')).toBe(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/DetachVolumeEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/VolumeReports.cs ResolveAttachmentAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/DetachVolumeCommandHandler.cs HandleAsync (restsUnattached:
  // answered like the first, nothing recorded, nothing sent) — titan-ops architecture/resource-lifecycle.md#repeat
  test('VOL-04 detach is 202, then not attached; a detach of a detached or never-attached volume is 202 and changes nothing', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/detach`), 202)
    const detached = await waitVolume('VOL-04', volumeA, (v) => v.currentAttachedVmId === null && v.transition === null)
    const actions = await activityOf(`rg-vola-${RUN}`)
    expect(countOf(actions, 'volume.detach_requested')).toBe(1)
    expect(countOf(actions, 'volume.detached')).toBe(1)

    const again = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/detach`)
    expectStatus(again, 202)
    expect(again.text).toBe('')
    expect(volumeShape(await readVolume(volumeA))).toBe(volumeShape(detached))
    expect(countOf(await activityOf(`rg-vola-${RUN}`), 'volume.detach_requested')).toBe(1)

    volumeB = await createVolume('volb')
    const fresh = await waitVolume('VOL-04 never attached', volumeB, settled)
    const never = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeB}/detach`)
    expectStatus(never, 202)
    expect(never.text).toBe('')
    expect(volumeShape(await readVolume(volumeB))).toBe(volumeShape(fresh))
    expect(countOf(await activityOf(`rg-volb-${RUN}`), 'volume.detach_requested')).toBe(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs EnsureHasRoom
  test('VOL-05 snapshots Exist; the one past the cap is 422 VOLUME_SNAPSHOT_QUOTA_EXCEEDED', async () => {
    for (let i = 1; i <= MAX_SNAPSHOTS_PER_VOLUME; i++) {
      const reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/snapshots`, { name: `rg-vsnap${i}-${RUN}` }, newKey())
      expectStatus(reply, 202)
      snapshotsOfA.push(bodyOf(reply).snapshotId)
    }
    for (const id of snapshotsOfA) {
      await pollUntil(`VOL-05 ${id}`, () => readSnapshot(volumeA, id), settled, snapshotShape)
    }
    expectError(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/snapshots`, { name: `rg-vsnap4-${RUN}` }, newKey()),
      422, 'VOLUME_SNAPSHOT_QUOTA_EXCEEDED')
    const actions = await activityOf(`rg-vsnap1-${RUN}`)
    expect(countOf(actions, 'volume_snapshot.create_requested')).toBe(1)
    expect(countOf(actions, 'volume_snapshot.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VolumeSnapshots/RestoreVolumeSnapshotEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/RestoreVolumeSnapshotCommandHandler.cs HandleAsync
  // (Volume.Create with the source's ClusterId, VolumeOfferingId, SizeGb and the body's name; activity.Stage("volume_snapshot.restore_requested") on the new volume)
  test('VOL-06 restore is 202 {newVolumeId}: a new volume Exists with the source sizing and the name sent, the source is unchanged', async () => {
    const name = `rg-volr-${RUN}`
    const source = await readVolume(volumeA)
    const reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/snapshots/${snapshotsOfA[0]}/restore`, { name }, newKey())
    expectStatus(reply, 202)
    restored = bodyOf(reply).newVolumeId as string
    made.push(restored)
    const volume = await waitVolume('VOL-06', restored, settled)
    expect(volume.name).toBe(name)
    expect(volume.clusterId).toBe(source.clusterId)
    expect(volume.volumeOfferingId).toBe(source.volumeOfferingId)
    expect(volume.sizeGb).toBe(source.sizeGb)
    const after = await readVolume(volumeA)
    expect(settled(after)).toBe(true)
    expect(volumeShape(after)).toBe(volumeShape(source))
    const actions = await activityOf(name)
    log(`ACT-02 restore ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'volume_snapshot.restore_requested')).toBe(1)
    expect(countOf(actions, 'volume.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs Delete (VOLUME_HAS_SNAPSHOTS)
  test('VOL-07 deleting a volume that still has snapshots is 422 VOLUME_HAS_SNAPSHOTS', async () => {
    expectError(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}`), 422, 'VOLUME_HAS_SNAPSHOTS')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VolumeSnapshots/DeleteVolumeSnapshotEndpoint.cs HandleAsync,
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/DeleteVolumeEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/DeleteVolumeSnapshotCommandHandler.cs HandleAsync
  // (IsDeletedOrDeleting: a repeat is answered like the first, nothing recorded) — titan-ops architecture/intent-and-observation.md#domain-refuses-a-repeat
  test('VOL-08 snapshots deleted first, then the volume: both reach Deleted; a repeat snapshot delete is 202 and records nothing', async () => {
    for (const id of snapshotsOfA) {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}/snapshots/${id}`), 202)
    }
    for (const id of snapshotsOfA) {
      await pollUntil(`VOL-08 ${id}`, () => readSnapshot(volumeA, id), (s) => s.currentExistence === 'Deleted', snapshotShape)
    }
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}/snapshots/${snapshotsOfA[0]}`), 202)
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}`), 202)
    await waitVolume('VOL-08', volumeA, (v) => v.currentExistence === 'Deleted')
    const actions = await activityOf(`rg-vola-${RUN}`)
    expect(countOf(actions, 'volume.delete_requested')).toBe(1)
    expect(countOf(actions, 'volume.deleted')).toBe(1)
    const snapshotActions = await activityOf(`rg-vsnap1-${RUN}`)
    log(`VOL-08 rg-vsnap1-${RUN}: ${snapshotActions.join(', ')}`)
    expect(countOf(snapshotActions, 'volume_snapshot.delete_requested')).toBe(1)
    expect(countOf(snapshotActions, 'volume_snapshot.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs SnapshotQuotaUsage ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/CreateVolumeSnapshotCommandHandler.cs HandleAsync
  // (FindByIdForUpdateAsync, then TenantQuotaGate) — titan-ops features/volume/design.md#counting-and-billing
  test('VOL-12 two snapshots asked at once for the last slot: one 202, one 422 VOLUME_SNAPSHOT_QUOTA_EXCEEDED, the volume holds the cap', async () => {
    const cap = (await adminRow()).maxVolumeSnapshotsPerVolume as number
    log(`VOL-12 cap ${cap}`)
    expect(cap, 'the race needs a cap of at least 1').toBeGreaterThan(0)
    await waitVolume('VOL-12 volume at rest', volumeB, settled)
    let counted = (await snapshotsOf(volumeB)).filter(countsTowardQuota).length
    let i = 0
    while (counted < cap - 1) {
      const id = await createSnapshot(volumeB, `rg-vbs${i}-${RUN}`)
      await pollUntil(`VOL-12 fill ${i}`, () => readSnapshot(volumeB, id), settled, snapshotShape)
      counted++
      i++
    }
    expect((await snapshotsOf(volumeB)).filter(countsTowardQuota).length).toBe(cap - 1)
    const path = `/v1/tenant/volumes/${volumeB}/snapshots`
    const [first, second] = await Promise.all([
      call('tenant', 'POST', path, { name: `rg-vbsx-${RUN}` }, newKey()),
      call('tenant', 'POST', path, { name: `rg-vbsy-${RUN}` }, newKey()),
    ])
    log(`VOL-12 answers: ${first.status} ${first.text.slice(0, 200)} | ${second.status} ${second.text.slice(0, 200)}`)
    expect([first.status, second.status].sort()).toEqual([202, 422])
    const won = first.status === 202 ? first : second
    const lost = first.status === 202 ? second : first
    expectError(lost, 422, 'VOLUME_SNAPSHOT_QUOTA_EXCEEDED')
    expect(Object.keys(bodyOf(won))).toEqual(['snapshotId'])
    await pollUntil('VOL-12 winner', () => readSnapshot(volumeB, bodyOf(won).snapshotId), settled, snapshotShape)
    const rows = await snapshotsOf(volumeB)
    log(`VOL-12 snapshots after: ${rows.map((s) => `${s.name}:${snapshotShape(s)}`).join(' | ')}`)
    expect(rows.length).toBe(cap)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs RequireVolumeSnapshot (the snapshot is the volume's
  // child entity: one of another volume answers like a missing one) · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/DeleteVolumeSnapshotCommandHandler.cs
  // and OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/RestoreVolumeSnapshotCommandHandler.cs HandleAsync — titan-ops architecture/code-structure.md#child-entity
  test("VOL-13 another volume's snapshot through this volume's route is 404 VOLUME_SNAPSHOT_NOT_FOUND on delete and restore", async () => {
    const snapshotOfB = (await snapshotsOf(volumeB)).find((s) => s.currentExistence === 'Exists' && s.transition === null)
    expect(snapshotOfB, 'VOL-12 leaves snapshots on volume B').toBeDefined()
    const name = `rg-vol13-${RUN}`
    expectError(await call('tenant', 'DELETE', `/v1/tenant/volumes/${restored}/snapshots/${snapshotOfB.id}`), 404, 'VOLUME_SNAPSHOT_NOT_FOUND')
    expectError(await call('tenant', 'POST', `/v1/tenant/volumes/${restored}/snapshots/${snapshotOfB.id}/restore`, { name }, newKey()),
      404, 'VOLUME_SNAPSHOT_NOT_FOUND')
    const after = await readSnapshot(volumeB, snapshotOfB.id)
    log(`VOL-13 snapshot of B after: ${snapshotShape(after)}`)
    expect(after.transition).toBeNull()
    expect(after.desiredExistence).toBe('Exists')
    expect(after.currentExistence).toBe('Exists')
    const rows = await get('tenant', '/v1/tenant/volumes') as any[]
    expect(rows.some((v) => v.name === name)).toBe(false)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs Delete (SnapshotQuotaUsage: a snapshot being deleted
  // no longer counts), FinishOperation ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/VolumeReports.cs FinishOperation (the snapshots waiting on their delete, read before the call) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Entities/VolumeSnapshot.cs EndWithItsVolume, FinishOperation (IsTerminal)
  // — titan-ops architecture/intent-and-observation.md#terminal-state-absorbs
  test('VOL-14 a volume deleted while its only snapshot is being deleted: 202, both Deleted, one volume_snapshot.deleted', async () => {
    const name = `rg-vrs-${RUN}`
    const id = await createSnapshot(restored, name)
    await pollUntil('VOL-14 snapshot', () => readSnapshot(restored, id), settled, snapshotShape)
    expect((await snapshotsOf(restored)).filter(countsTowardQuota).map((s) => s.id)).toEqual([id])
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${restored}/snapshots/${id}`), 202)
    const reply = await call('tenant', 'DELETE', `/v1/tenant/volumes/${restored}`)
    const snapshotThen = await readSnapshot(restored, id)
    log(`VOL-14 snapshot when the volume delete was answered: ${snapshotShape(snapshotThen)}`)
    expectStatus(reply, 202)
    await waitVolume('VOL-14 volume deleted', restored, (v) => v.currentExistence === 'Deleted')
    await pollUntil('VOL-14 snapshot deleted', () => readSnapshot(restored, id), (s) => s.currentExistence === 'Deleted', snapshotShape)
    // The report that came second may still be on its way; it must record nothing.
    await sleep(20_000)
    const actions = await activityOf(name)
    log(`VOL-14 ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'volume_snapshot.delete_requested')).toBe(1)
    expect(countOf(actions, 'volume_snapshot.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/CreateVolumeSnapshotCommandHandler.cs HandleAsync
  // (TenantQuotaGate.EnsureHasRoom before volume.AddSnapshot) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs
  // EnsureSnapshottable (VOLUME_INVALID_STATE) · OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs
  // EnsureHasRoom (count >= cap) — titan-ops architecture/code-structure.md#quota-gate
  test('VOL-15 with maxVolumeSnapshotsPerVolume 0, a snapshot of a volume not yet Exists is 422 VOLUME_SNAPSHOT_QUOTA_EXCEEDED, not VOLUME_INVALID_STATE', async () => {
    const original = (await adminRow()).maxVolumeSnapshotsPerVolume as number
    const name = `rg-vol15-${RUN}`
    let reply: Reply | undefined
    let right: any
    await setQuota({ maxVolumeSnapshotsPerVolume: 0 })
    try {
      volumeC = await createVolume('volc')
      reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeC}/snapshots`, { name }, newKey())
      right = await readVolume(volumeC)
    } finally {
      await setQuota({ maxVolumeSnapshotsPerVolume: original })
    }
    log(`VOL-15 volume right after the snapshot request: ${volumeShape(right)}`)
    if (settled(right)) {
      test.info().annotations.push({ type: 'note', description: 'the volume already Existed: the order of the two checks was not measured' })
    }
    expectError(reply!, 422, 'VOLUME_SNAPSHOT_QUOTA_EXCEEDED')
    await waitVolume('VOL-15 volume C', volumeC, settled)
    expect(await snapshotsOf(volumeC)).toEqual([])
    expect(countOf(await activityOf(name), 'volume_snapshot.create_requested')).toBe(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/RestoreVolumeSnapshotCommandHandler.cs HandleAsync
  // (ProviderIdForSnapshotRestore before TenantQuotaGate: a snapshot that cannot be restored answers that first) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Entities/VolumeSnapshot.cs EnsureRestorable (VOLUME_SNAPSHOT_INVALID_STATE)
  // — titan-ops architecture/code-structure.md#quota-gate
  test('VOL-16 with maxVolumes 0, restoring a snapshot not yet Exists is 422 VOLUME_SNAPSHOT_INVALID_STATE, not VOLUME_QUOTA_EXCEEDED', async () => {
    const original = (await adminRow()).maxVolumes as number
    const snapshotName = `rg-vcs-${RUN}`
    const name = `rg-vol16-${RUN}`
    let reply: Reply | undefined
    let right: any
    await setQuota({ maxVolumes: 0 })
    try {
      snapshotOfC = await createSnapshot(volumeC, snapshotName)
      reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeC}/snapshots/${snapshotOfC}/restore`, { name }, newKey())
      right = await readSnapshot(volumeC, snapshotOfC)
    } finally {
      await setQuota({ maxVolumes: original })
    }
    log(`VOL-16 snapshot right after the restore request: ${snapshotShape(right)}`)
    if (settled(right)) {
      test.info().annotations.push({ type: 'note', description: 'the snapshot already Existed: the order of the two checks was not measured' })
    }
    expectError(reply!, 422, 'VOLUME_SNAPSHOT_INVALID_STATE')
    const rows = await get('tenant', '/v1/tenant/volumes') as any[]
    expect(rows.some((v) => v.name === name)).toBe(false)
    await pollUntil('VOL-16 snapshot', () => readSnapshot(volumeC, snapshotOfC), settled, snapshotShape)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs RequireVolumeForUpdateAsync, RequireVolumeAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/AttachVolumeCommandHandler.cs HandleAsync (the volume is looked up
  // before the VM) · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/CreateVolumeSnapshotCommandHandler.cs and
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/VolumeSnapshot/RestoreVolumeSnapshotCommandHandler.cs HandleAsync (VOLUME_NOT_FOUND for another tenant's volume) — titan-ops architecture/tenancy-and-admin.md#tenant-isolation
  test("VOL-19 another tenant's volume is not listed and every route on it is 404 VOLUME_NOT_FOUND; nothing changes", async () => {
    const volumeName = `rg-volc-${RUN}`
    const snapshotName = `rg-vcs-${RUN}`
    const restoreName = `rg-vol19-${RUN}`
    const before = await feedIds()
    const ownBefore = (await get('tenant', '/v1/tenant/volumes') as any[]).map((v) => v.id).sort()
    const base = `/v1/tenant/volumes/${volumeC}`

    const listed = await get('admin', '/v1/tenant/volumes') as any[]
    expect(listed.some((v) => v.id === volumeC)).toBe(false)
    expectError(await call('admin', 'POST', `${base}/attach`, { vmId: randomUUID() }), 404, 'VOLUME_NOT_FOUND')
    expectError(await call('admin', 'POST', `${base}/detach`), 404, 'VOLUME_NOT_FOUND')
    expectError(await call('admin', 'DELETE', base), 404, 'VOLUME_NOT_FOUND')
    expectError(await call('admin', 'GET', `${base}/snapshots`), 404, 'VOLUME_NOT_FOUND')
    expectError(await call('admin', 'POST', `${base}/snapshots`, { name: `rg-vol19s-${RUN}` }, newKey()), 404, 'VOLUME_NOT_FOUND')
    expectError(await call('admin', 'DELETE', `${base}/snapshots/${snapshotOfC}`), 404, 'VOLUME_NOT_FOUND')
    expectError(await call('admin', 'POST', `${base}/snapshots/${snapshotOfC}/restore`, { name: restoreName }, newKey()), 404, 'VOLUME_NOT_FOUND')

    const volume = await readVolume(volumeC)
    log(`VOL-19 owner's volume after: ${volumeShape(volume)}`)
    expect(settled(volume)).toBe(true)
    expect(volume.desiredExistence).toBe('Exists')
    const snapshot = await readSnapshot(volumeC, snapshotOfC)
    expect(snapshot.transition).toBeNull()
    expect(snapshot.desiredExistence).toBe('Exists')
    expect((await get('tenant', '/v1/tenant/volumes') as any[]).map((v) => v.id).sort()).toEqual(ownBefore)
    expect((await get('admin', '/v1/tenant/volumes') as any[]).some((v) => v.name === restoreName)).toBe(false)
    expect(await newActionsOf(before, volumeName)).toEqual([])
    expect(await newActionsOf(before, snapshotName)).toEqual([])
    expect(await newActionsOf(before, restoreName)).toEqual([])
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/DetachVolumeCommandHandler.cs HandleAsync (detachIsWaiting) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/AttachVolumeCommandHandler.cs HandleAsync (attachIsWaiting, toThisVm):
  // a repeat is answered like the first, nothing recorded, nothing sent — titan-ops architecture/resource-lifecycle.md#repeat ·
  // titan-ops architecture/resource-lifecycle.md#one-key-per-request
  test('VOL-17 a detach repeated while Detaching and an attach repeated while Attaching are 202, one request and one outcome each', async () => {
    const name = `rg-volc-${RUN}`
    const base = `/v1/tenant/volumes/${volumeC}`
    expectStatus(await call('tenant', 'POST', `${base}/attach`, { vmId }), 202)
    await waitVolume('VOL-17 attached at rest', volumeC, (v) => v.currentAttachedVmId === vmId && v.transition === null)
    const skipped: string[] = []

    let before = await feedIds()
    expectStatus(await call('tenant', 'POST', `${base}/detach`), 202)
    const detaching = await readVolume(volumeC)
    log(`VOL-17 detach lap: ${volumeShape(detaching)}`)
    if (detaching.transition === 'Detaching') {
      const repeat = await call('tenant', 'POST', `${base}/detach`)
      expectStatus(repeat, 202)
      expect(repeat.text).toBe('')
    } else {
      skipped.push('detach lap: the detach had already ended before the repeat could be sent')
    }
    await waitVolume('VOL-17 detached', volumeC, (v) => v.currentAttachedVmId === null && v.transition === null)
    let actions = await newActionsOf(before, name)
    log(`VOL-17 detach lap ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'volume.detach_requested')).toBe(1)
    expect(countOf(actions, 'volume.detached')).toBe(1)

    before = await feedIds()
    expectStatus(await call('tenant', 'POST', `${base}/attach`, { vmId }), 202)
    const attaching = await readVolume(volumeC)
    log(`VOL-17 attach lap: ${volumeShape(attaching)}`)
    if (attaching.transition === 'Attaching') {
      const repeat = await call('tenant', 'POST', `${base}/attach`, { vmId })
      expectStatus(repeat, 202)
      expect(repeat.text).toBe('')
    } else {
      skipped.push('attach lap: the attach had already ended before the repeat could be sent')
    }
    await waitVolume('VOL-17 attached again', volumeC, (v) => v.currentAttachedVmId === vmId && v.transition === null)
    actions = await newActionsOf(before, name)
    log(`VOL-17 attach lap ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'volume.attach_requested')).toBe(1)
    expect(countOf(actions, 'volume.attached')).toBe(1)

    for (const reason of skipped) {
      log(`VOL-17 skipped ${reason}`)
      test.info().annotations.push({ type: 'skipped lap', description: reason })
    }
    test.skip(skipped.length === 2, `both laps skipped: ${skipped.join('; ')}`)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs OccupiesQuota ·
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Platform/Tenant/TenantQuotaGate.cs EnsureHasRoom
  test('VOL-10 the volume past MaxVolumes is 422 VOLUME_QUOTA_EXCEEDED', async () => {
    // The server's count (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Volume/Volume.cs OccupiesQuota; VolumeRepository.CountActiveByTenantAsync writes the same condition in SQL): desired Exists and (Exists, or its create waits).
    const live = (await get('tenant', '/v1/tenant/volumes') as any[])
      .filter((v) => v.desiredExistence === 'Exists' && (v.currentExistence === 'Exists' || v.transition === 'Creating')).length
    log(`VOL-10 live volumes before: ${live}`)
    const missing = MAX_VOLUMES - live
    for (let i = 0; i < missing; i++) {
      await createVolume(`volq${i}`)
    }
    expectError(await call('tenant', 'POST', '/v1/tenant/volumes',
      { name: `rg-volq-over-${RUN}`, volumeOfferingId: (await envOf()).volumeOfferingId, clusterId: (await envOf()).clusterId, sizeGb: 1 }, newKey()),
      422, 'VOLUME_QUOTA_EXCEEDED')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/DeleteVmCommandHandler.cs HandleAsync (ListAttachedToVmLockedAsync, volume.ReleaseFromVmDelete),
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/VmReports.cs FinishOperationAsync (volume.MarkDetachedByVmDelete).
  // The spec measures the end without desiredAttachedVmId; plan.md VOL-09 also expects no transition while the VM's delete
  // waits, then no desired attachment and a delete that goes through, and the release that writes its spec tightens it.
  test('VOL-09 deleting a VM releases the volume attached to it, which stays', async () => {
    const id = made[made.length - 1]
    await waitVolume('VOL-09 ready', id, settled)
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${id}/attach`, { vmId }), 202)
    await waitVolume('VOL-09 attached', id, (v) => v.currentAttachedVmId === vmId && v.transition === null)
    await deleteVmAndWait(vmId)
    vmId = ''
    const volume = await waitVolume('VOL-09 released', id, (v) => v.currentAttachedVmId === null && v.transition === null)
    expect(volume.currentExistence).toBe('Exists')
  })
})
