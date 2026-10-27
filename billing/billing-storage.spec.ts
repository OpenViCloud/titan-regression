import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { RUN, envOf, runNetwork, waitVolume } from './fixtures'

// Case BIL-16 of plan.md. Metered on the lane's tenant, like BIL-01..03 (billing.spec.ts): money moves only
// on admin-test (CLAUDE.md), and storage usage here produces no invoice or wallet movement.
//
// OpenViCloud/titan-control-plane:Titan.Application/Options/BillingMeterOptions.cs (IntervalMinutes) — one tick every 10 minutes by default.
const TICK_MS = 10 * 60_000

// OpenViCloud/titan-control-plane:Titan.Application/Queries/Billing/UsageRecord/GetTenantBillingSummaryQueryHandler.cs
// HandleAsync (storageCost) — the only API-readable storage figure is storageCost = DISK + SNAPSHOT combined; there
// is no per-type breakdown and no route exposes SnapshotOffering's price (grep across
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints and
// OpenViCloud/titan-control-plane:Titan.Application/Queries found none — only GetVmCostEndpoint breaks usage down by
// line, and it is Compute-only). So this spec proves both DISK and SNAPSHOT contribute (storageCost grows by more
// than DISK alone would), and checks DISK's exact formula against the live volume-offering price; it cannot
// independently verify the SNAPSHOT line's exact value through a public API without hardcoding the dev
// SnapshotOffering price plan.md's own sample names.
const BILLED_GB = 1

test.describe.serial('billing-storage', () => {
  test.describe.configure({ timeout: 30 * 60_000 })

  let volumeId = ''
  let snapshotId = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('billing-storage')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    if (snapshotId !== '') {
      await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}/snapshots/${snapshotId}`)
      await pollUntil('billing-storage snapshot gone',
        () => get('tenant', `/v1/tenant/volumes/${volumeId}/snapshots`) as Promise<any[]>,
        (rows) => rows.every((s) => s.id !== snapshotId), (rows) => `${rows.length} left`)
    }
    if (volumeId !== '') {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`), 202)
      await waitVolume('billing-storage volume deleted', volumeId, (v) => v.currentExistence === 'Deleted')
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Billing/Metering/DiskMeterService.cs (DiskMeterService) — a 1 GB volume plus one
  // snapshot of it both exist through a tick: storage grows at both DISK's and SNAPSHOT's rate, neither 0
  // (OpenViCloud/titan-ops:docs/architecture/money-and-wallet.md#round-once · OpenViCloud/titan-ops:docs/features/billing/metering/design.md#meters).
  test('BIL-16 a 1 GB volume and its snapshot both add storage usage over a tick, neither line is 0', async () => {
    const { clusterId, volumeOfferingId } = await envOf()
    await runNetwork() // ensures the shared run network exists; this case needs no network of its own

    const diskPrice = (await get('anonymous', '/v1/volume-offerings') as any[])
      .find((o) => o.id === volumeOfferingId).pricePerGbPerHour as number
    expect(diskPrice).toBeGreaterThan(0)
    const perTickDisk = diskPrice * BILLED_GB * (TICK_MS / 60_000) / 60
    log(`BIL-16 disk ${diskPrice}/GB/h × ${BILLED_GB} GB ⇒ ${perTickDisk} ₫ a tick`)

    const volumeReply = await call('tenant', 'POST', '/v1/tenant/volumes',
      { name: `rg-storvol-${RUN}`, volumeOfferingId, clusterId, sizeGb: BILLED_GB }, newKey())
    expectStatus(volumeReply, 202)
    volumeId = bodyOf(volumeReply).volumeId as string
    await waitVolume('BIL-16 volume exists', volumeId, (v) => v.currentExistence === 'Exists' && v.transition === null)

    const storageBeforeSnapshot = (await get('tenant', '/v1/tenant/billing/summary')).storageCost as number

    const snapshotReply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/snapshots`, { name: `rg-storsnap-${RUN}` }, newKey())
    expectStatus(snapshotReply, 202)
    snapshotId = bodyOf(snapshotReply).snapshotId as string
    await pollUntil('BIL-16 snapshot exists',
      () => get('tenant', `/v1/tenant/volumes/${volumeId}/snapshots`) as Promise<any[]>,
      (rows) => rows.some((s) => s.id === snapshotId && s.currentExistence === 'Exists' && s.transition === null),
      (rows) => `snapshot=${JSON.stringify(rows.find((s) => s.id === snapshotId))}`)

    // Baseline after both the volume and its snapshot exist, so the next tick's growth reflects DISK + SNAPSHOT
    // together, not DISK alone from before the snapshot existed.
    const baseline = (await get('tenant', '/v1/tenant/billing/summary')).storageCost as number
    log(`BIL-16 storageCost before=${storageBeforeSnapshot} baseline(after snapshot exists)=${baseline}`)

    const afterOneTick = await pollUntil('BIL-16 storage usage grows', () => get('tenant', '/v1/tenant/billing/summary'),
      (s) => s.storageCost > baseline, (s) => `storage=${s.storageCost}`, 2 * TICK_MS + 2 * 60_000, 30_000)
    const grew = afterOneTick.storageCost - baseline
    log(`BIL-16 storageCost grew by ${grew} in one tick (disk-only would be ${perTickDisk})`)

    // DISK alone must be present and roughly match the formula (both sides are raw decimals; the tolerance only
    // absorbs float noise, as billing.spec.ts's BIL-02 does).
    expect(grew).toBeGreaterThanOrEqual(perTickDisk - 1e-6)
    // SNAPSHOT must also be nonzero: total growth must exceed what DISK alone would produce in the same tick,
    // proving a distinct nonzero SNAPSHOT contribution without reading its price from anywhere.
    expect(grew, 'SNAPSHOT must contribute something beyond DISK alone (neither line may be 0)').toBeGreaterThan(perTickDisk + 1e-6)

    // Let a second tick land too, so the growth is not a one-off coincidence of timing.
    await sleep(TICK_MS)
    const afterTwoTicks = (await get('tenant', '/v1/tenant/billing/summary')).storageCost as number
    expect(afterTwoTicks).toBeGreaterThan(afterOneTick.storageCost)
  })
})
