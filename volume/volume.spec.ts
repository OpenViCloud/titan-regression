import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, readVolume, runNetwork, runs, waitVm, waitVolume } from './fixtures'

// Cases VOL-01..10 of plan.md, plus ACT-02 for volumes and volume snapshots (VOL-11 reads the Incus host).

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Platform/Tenant/TenantQuota.cs DefaultMaxVolumes, DefaultMaxVolumeSnapshotsPerVolume — no API reads the caps
const MAX_VOLUMES = 10
const MAX_SNAPSHOTS_PER_VOLUME = 3

function snapshotShape(s: any): string {
  return `existence=${s.currentExistence} desired=${s.desiredExistence} transition=${s.transition} failure=${s.requestFailureReason}`
}

function settled(v: any): boolean {
  return v.currentExistence === 'Exists' && v.transition === null
}

test.describe.serial('volume', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  const made: string[] = []
  let vmId = ''
  let volumeA = ''
  const snapshotsOfA: string[] = []

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

  async function readSnapshot(volumeId: string, id: string): Promise<any> {
    const rows = await get('tenant', `/v1/tenant/volumes/${volumeId}/snapshots`) as any[]
    const row = rows.find((s) => s.id === id)
    if (row === undefined) {
      return { currentExistence: 'Deleted' }
    }
    return row
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
    const snaps = await get('tenant', `/v1/tenant/volumes/${id}/snapshots`) as any[]
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

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('volume')
    useBrowser(browser)
    const { smallTier } = await envOf()
    const networkId = (await runNetwork()).id
    vmId = await createVm(`rg-volvm-${RUN}`, smallTier, networkId)
    await waitVm('volume VM runs', vmId, runs)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    for (const id of made) {
      await deleteVolumeAndWait(id)
    }
    if (vmId !== '') {
      await deleteVmAndWait(vmId)
    }
    await closeSessions()
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

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/AttachVolumeEndpoint.cs HandleAsync — 202, no body;
  // attachment is read from used_by (titan-ops features/volume/design.md#attachment-from-used-by)
  test('VOL-03 attach to a running VM is 202 with no body, then attached to it', async () => {
    const reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/attach`, { vmId })
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    const volume = await waitVolume('VOL-03', volumeA, (v) => v.currentAttachedVmId === vmId && v.transition === null)
    expect(volume.currentAttachedElsewhere).toBe(false)
    const actions = await activityOf(`rg-vola-${RUN}`)
    expect(countOf(actions, 'volume.attach_requested')).toBe(1)
    expect(countOf(actions, 'volume.attached')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/DetachVolumeEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/UpdateVolumeStatusCommandHandler.cs ApplyObservationAsync (ResolveAttachmentAsync)
  test('VOL-04 detach is 202, then not attached', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/detach`), 202)
    await waitVolume('VOL-04', volumeA, (v) => v.currentAttachedVmId === null && v.transition === null)
    const actions = await activityOf(`rg-vola-${RUN}`)
    expect(countOf(actions, 'volume.detach_requested')).toBe(1)
    expect(countOf(actions, 'volume.detached')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Platform/Tenant/Tenant.cs EnsureCanCreateVolumeSnapshot
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
  // (activity.Stage("volume_snapshot.restore_requested") on the new volume)
  test('VOL-06 restore is 202 {newVolumeId}: a new volume Exists, the source is unchanged', async () => {
    const name = `rg-volr-${RUN}`
    const reply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeA}/snapshots/${snapshotsOfA[0]}/restore`, { name }, newKey())
    expectStatus(reply, 202)
    const restored = bodyOf(reply).newVolumeId as string
    made.push(restored)
    await waitVolume('VOL-06', restored, settled)
    const source = await readVolume(volumeA)
    expect(settled(source)).toBe(true)
    const actions = await activityOf(name)
    log(`ACT-02 restore ${name}: ${actions.join(', ')}`)
    expect(countOf(actions, 'volume_snapshot.restore_requested')).toBe(1)
    expect(countOf(actions, 'volume.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Compute/Volume/Volume.cs RequestDelete (VOLUME_HAS_SNAPSHOTS)
  test('VOL-07 deleting a volume that still has snapshots is 422 VOLUME_HAS_SNAPSHOTS', async () => {
    expectError(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}`), 422, 'VOLUME_HAS_SNAPSHOTS')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/VolumeSnapshots/DeleteVolumeSnapshotEndpoint.cs HandleAsync,
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Volume/DeleteVolumeEndpoint.cs HandleAsync
  test('VOL-08 snapshots deleted first, then the volume: both reach Deleted', async () => {
    for (const id of snapshotsOfA) {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}/snapshots/${id}`), 202)
    }
    for (const id of snapshotsOfA) {
      await pollUntil(`VOL-08 ${id}`, () => readSnapshot(volumeA, id), (s) => s.currentExistence === 'Deleted', snapshotShape)
    }
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeA}`), 202)
    await waitVolume('VOL-08', volumeA, (v) => v.currentExistence === 'Deleted')
    const actions = await activityOf(`rg-vola-${RUN}`)
    expect(countOf(actions, 'volume.delete_requested')).toBe(1)
    expect(countOf(actions, 'volume.deleted')).toBe(1)
    const snapshotActions = await activityOf(`rg-vsnap1-${RUN}`)
    expect(countOf(snapshotActions, 'volume_snapshot.delete_requested')).toBe(1)
    expect(countOf(snapshotActions, 'volume_snapshot.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VolumeRepository.cs CountActiveByTenantAsync ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Platform/Tenant/Tenant.cs EnsureCanCreateVolume
  test('VOL-10 the volume past MaxVolumes is 422 VOLUME_QUOTA_EXCEEDED', async () => {
    // The server's count (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VolumeRepository.cs CountActiveByTenantAsync): desired Exists and (Exists, or its create waits).
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

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/DeleteVmCommandHandler.cs HandleAsync (ListAttachedToVmAsync: the volumes go as detaches),
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/UpdateVmStatusCommandHandler.cs HandleAsync (volume.MarkDetachedByVmDelete)
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
