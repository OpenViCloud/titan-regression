import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, bodyOf, call, expectStatus, get, log, pollUntil, startLog } from './api'
import { activityOf, countOf, envOf, nameOf, runNetwork, runs, waitVm, waitVolume } from './fixtures'
import { topUpEnabledOf } from './portal-config'

// Cases UI-01..08 and UI-34 of plan.md: dashboard gate, VM create/snapshot/volume/stop-start-delete, billing,
// wallet, buy-credit, the static account pages and the billing page's past months. Two independent describe.serial groups so a slow VM boot
// (group A) cannot erase the billing/wallet/account coverage (group B), which needs no VM. UI-07 is N/A where the
// portal config has no topUpEnabled: true.

async function readVm(vmId: string): Promise<any> {
  return get('tenant', `/v1/tenant/vms/${vmId}`)
}

async function readVolume(id: string): Promise<any> {
  const rows = await get('tenant', '/v1/tenant/volumes') as any[]
  const row = rows.find((r) => r.id === id)
  return row === undefined ? { status: 'Deleted' } : row
}

// VolumeStatus: Creating, Attaching, Detaching, Deleting are in flight; everything else is at rest.
function volumeAtRest(v: any): boolean {
  return v.status !== 'Creating' && v.status !== 'Attaching' && v.status !== 'Detaching' && v.status !== 'Deleting'
}

// Same cleanup shape as volume/volume.spec.ts: return at once on Deleted, drain attach and
// snapshots first, otherwise a DELETE or detach on an already-deleted volume 404s or no-ops into an error.
async function deleteVolumeAndWait(id: string): Promise<void> {
  const volume = await waitVolume(`volume ${id} at rest`, id, volumeAtRest)
  if (volume.status === 'Deleted') {
    return
  }
  if (volume.currentAttachedVmId !== null) {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${id}/detach`), 202)
    await waitVolume('detached for cleanup', id, (v) => v.currentAttachedVmId === null && volumeAtRest(v))
  }
  const snaps = await get('tenant', `/v1/tenant/volumes/${id}/snapshots`) as any[]
  for (const snap of snaps) {
    if (snap.status !== 'Deleting' && snap.status !== 'Deleted') {
      await pollUntil('snapshot at rest', () => get('tenant', `/v1/tenant/volumes/${id}/snapshots`).then((rows: any[]) => rows.find((s) => s.id === snap.id)),
        (s) => s === undefined || (s.status !== 'Creating' && s.status !== 'Deleting'), (s) => `status=${s?.status}`)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${id}/snapshots/${snap.id}`), 202)
    }
  }
  expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${id}`), 202)
  await waitVolume('volume deleted', id, (v) => v.status === 'Deleted')
}

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Mirrors OpenViCloud/titan-cloud-console:portal/src/lib/money.ts formatMoney for 'en' + 'VND': Math.round(amount).toLocaleString('en-US') + ' ₫'.
function moneyEn(amount: number): string {
  return `${Math.round(amount).toLocaleString('en-US')} ₫`
}

// The month's cost shown on a page against the API's, read before and after the page: metering can tick a VM's usage up
// between the two reads (titan-ops features/billing/metering/design.md#meter-liveness), so either value is accepted, and a
// tick that falls between the two reads and the page (a third value) shows the page again, up to three times.
async function costShownMatches(label: string, read: () => Promise<number>, show: () => Promise<string | null>): Promise<string | null> {
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await read()
    const shown = await show()
    const after = await read()
    const expectedOneOf = [moneyEn(before), moneyEn(after)]
    if (shown !== null && expectedOneOf.includes(shown)) {
      return shown
    }
    last = `attempt ${attempt}: shown "${shown}", API before ${expectedOneOf[0]} after ${expectedOneOf[1]}`
    log(`${label} ${last}`)
  }
  throw new Error(`${label} the cost shown never matched the API (${last})`)
}

// ---------------------------------------------------------------------------------------------------------------
// Group A: UI-01 (gate + dashboard), UI-02 (create VM), UI-04 (snapshot + volume), UI-03 (stop/start/delete,
// feed refresh). UI-04 runs on the still-running VM, before UI-03 stops and deletes it.
// ---------------------------------------------------------------------------------------------------------------

test.describe.serial('portal-ui flows: VM lifecycle', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  let vmId = ''
  let volumeId = ''
  const vmName = nameOf('vmflow')
  const volumeName = nameOf('volflow')

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-flows')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    if (volumeId !== '') {
      await deleteVolumeAndWait(volumeId)
    }
    if (vmId !== '') {
      const vm = await readVm(vmId)
      if (vm.status !== 'Deleted') {
        // VmSnapshotStatus: Creating, Reverting, Deleting are in flight; everything else is at rest.
        await pollUntil('cleanup: VM has no snapshot in progress', async () => {
          const reply = await call('tenant', 'GET', `/v1/tenant/vms/${vmId}/snapshots`)
          return reply.status === 200 ? bodyOf(reply) as any[] : []
        }, (rows) => rows.every((s) => s.status !== 'Creating' && s.status !== 'Reverting' && s.status !== 'Deleting'),
          (rows) => rows.map((s: any) => s.status).join(','))
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`), 202)
      }
      await waitVm('cleanup: VM deleted', vmId, (v) => v.status === 'Deleted')
    }
    await closeSessions()
  })

  // titan-ops features/cloud-console/design.md#portal-gate-order · OpenViCloud/titan-cloud-console:portal/src/contexts/TenantContext.tsx
  // (TenantProvider: PendingApproval → consent gate → app) · OpenViCloud/titan-cloud-console:portal/src/components/ConsentGate.tsx
  // OpenViCloud/titan-cloud-console:portal/src/pages/DashboardPage.tsx
  test('UI-01 beta-user signs in, passes the gates, and the dashboard KPIs match the API', async () => {
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })

    // The consent gate IS one of the gates this case covers (OpenViCloud/titan-cloud-console:portal/src/components/ConsentGate.tsx): go through it in the UI rather
    // than clearing it over the API, so a caller still owing consent is actually exercised here.
    const consentGate = page.getByTestId('consent-gate')
    if (await consentGate.isVisible().catch(() => false)) {
      await page.getByTestId('consent-checkbox').check()
      await page.getByTestId('consent-accept').click()
      await expect(consentGate).toHaveCount(0)
      log('UI-01 consent gate was shown and accepted')
    }

    // Past the gates: the dashboard heading renders, not a consent screen or a pending-approval screen.
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
    await expect(page.getByTestId('consent-gate')).toHaveCount(0)

    const [vms, networks, volumes] = await Promise.all([
      get('tenant', '/v1/tenant/vms') as Promise<any[]>,
      get('tenant', '/v1/tenant/networks') as Promise<any[]>,
      get('tenant', '/v1/tenant/volumes') as Promise<any[]>,
    ])
    await expect(page.getByTestId('vm-count')).toHaveText(String(vms.length))
    await expect(page.getByTestId('network-count')).toHaveText(String(networks.length))
    await expect(page.getByTestId('volume-count')).toHaveText(String(volumes.length))

    let shownOnce = false
    const shown = await costShownMatches('UI-01',
      async () => (await get('tenant', `/v1/tenant/billing/summary?month=${currentMonth()}`)).totalCost,
      async () => {
        if (shownOnce) {
          await page.reload({ waitUntil: 'networkidle' })
        }
        shownOnce = true
        const text = await page.getByTestId('month-cost').textContent()
        await page.screenshot({ path: `${RESULTS}/UI-01-dashboard.png` })
        return text
      })
    log(`UI-01 vms=${vms.length} networks=${networks.length} volumes=${volumes.length} monthCost=${shown}`)
  })

  // titan-ops features/vm/design.md#vm-portal · OpenViCloud/titan-cloud-console:portal/src/components/VmCreateModal.tsx
  test('UI-02 creating a VM through the form shows the transition then Running, with the right name and tier', async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    const offerings = await get('anonymous', '/v1/vm-offerings') as Array<{ id: string, name: string }>
    const tierName = offerings.find((o) => o.id === smallTier)?.name ?? smallTier
    const network = await runNetwork()
    // pageOf() again after every wait on the API: a sign-in closes the old context (auth.ts headersOf).
    let page = await pageOf('tenant')
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create VM' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Create Virtual Machine' })).toBeVisible()
    // The form has no IPv6 field at all (titan-ops features/network/design.md#ipv6-public: IPv6 is a network
    // property, requested at network create, not at VM create).
    await expect(dialog.getByText(/ipv6/i)).toHaveCount(0)

    await dialog.getByPlaceholder('e.g. web-server-01').fill(vmName)
    await dialog.getByRole('combobox', { name: 'Cluster' }).selectOption(clusterId)
    await dialog.getByRole('combobox', { name: 'Network' }).selectOption(network.id)
    await dialog.getByRole('combobox', { name: 'Template' }).selectOption(templateId)
    await dialog.getByRole('combobox', { name: 'Size' }).selectOption(smallTier)
    await dialog.getByRole('button', { name: 'Create VM' }).click()
    await expect(dialog).toHaveCount(0)

    // Read the id back right away, before any further UI assertion, so a later failure still leaves
    // cleanup able to find and delete the VM.
    const created = await pollUntil('UI-02 vm appears in the list', () => get('tenant', '/v1/tenant/vms') as Promise<any[]>,
      (rows) => rows.some((v) => v.name === vmName), (rows) => `count=${rows.length}`)
    vmId = created.find((v) => v.name === vmName).id

    const rowOf = () => page.getByRole('listitem').filter({ hasText: vmName })
    await expect(rowOf()).toBeVisible()
    // The badge text "Creating" (exact) is distinct from the disabled "Creating…" action button
    // (OpenViCloud/titan-cloud-console:portal/src/components/vm/VmActions.tsx renders both while a request is pending) — exact avoids a strict-mode collision.
    await expect(rowOf().getByText('Creating', { exact: true })).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-02-vm-creating.png` })

    await waitVm('UI-02 vm running', vmId, runs)
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    // Incus may settle on Running or Ready (titan-ops features/vm/design.md#status-mapping); either satisfies "runs".
    await expect(rowOf().getByText(/^(Running|Ready)$/)).toBeVisible()
    await expect(rowOf()).toContainText(vmName)
    await expect(rowOf()).toContainText(tierName)
    await page.screenshot({ path: `${RESULTS}/UI-02-vm-running.png` })
    log(`UI-02 ${vmName} id=${vmId} tier=${tierName}`)
  })

  // titan-ops features/volume/design.md#volume-portal · OpenViCloud/titan-cloud-console:portal/src/pages/VmDetailPage.tsx (Snapshots tab)
  // OpenViCloud/titan-cloud-console:portal/src/pages/VolumeListPage.tsx (create, attach, detach)
  test('UI-04 VM snapshot and volume create/attach/detach/delete through the portal', async () => {
    test.skip(vmId === '', 'UI-02 did not create a VM')
    // pageOf() again after every wait on the API: a sign-in closes the old context (auth.ts headersOf).
    let page = await pageOf('tenant')

    // --- VM snapshot, from the VM page's Snapshots tab -------------------------------------------------------
    await page.goto(PORTAL + `/vms/${vmId}`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: 'Snapshots' }).click()
    await page.getByRole('button', { name: 'New Snapshot' }).click()
    const snapName = nameOf('vmsnapui')
    await page.getByPlaceholder('Snapshot name').fill(snapName)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const snapRow = page.locator('div').filter({ hasText: snapName }).last()
    await expect(snapRow).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-04-vm-snapshot.png` })

    const snaps = await pollUntil('UI-04 snapshot appears', () => get('tenant', `/v1/tenant/vms/${vmId}/snapshots`) as Promise<any[]>,
      (rows) => rows.some((s) => s.name === snapName), (rows) => `count=${rows.length}`)
    const snap = snaps.find((s) => s.name === snapName)
    await pollUntil('UI-04 snapshot available', () => get('tenant', `/v1/tenant/vms/${vmId}/snapshots`).then((rows: any[]) => rows.find((s) => s.id === snap.id)),
      (s) => s.status === 'Available', (s) => `status=${s.status}`)
    page = await pageOf('tenant')
    await page.goto(PORTAL + `/vms/${vmId}`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: 'Snapshots' }).click()
    await expect(page.getByText('Available').first()).toBeVisible()
    await page.getByRole('button', { name: 'Delete snapshot' }).first().click()
    await page.getByRole('button', { name: 'Confirm' }).click()
    // Done when the row is gone from the list OR the API itself reports it Deleted — the UI may drop a
    // Deleted row from the list entirely rather than rendering a terminal badge for it.
    await pollUntil('UI-04 snapshot deleted', () => get('tenant', `/v1/tenant/vms/${vmId}/snapshots`) as Promise<any[]>,
      (rows) => {
        const row = rows.find((s) => s.id === snap.id)
        return row === undefined || row.status === 'Deleted'
      }, (rows) => `count=${rows.length}`)

    // --- Volume: create, attach, detach, delete --------------------------------------------------------------
    const { clusterId, volumeOfferingId } = await envOf()
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/volumes', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create Volume' }).click()
    const volDialog = page.getByRole('dialog')
    await volDialog.getByPlaceholder('e.g. data-vol-01').fill(volumeName)
    // Cluster and offering selects carry no accessible name (OpenViCloud/titan-cloud-console:portal/src/components/VolumeCreateModal.tsx — unlabeled <select>,
    // unlike VmCreateModal's): scope to the dialog and pick by position — cluster first, offering second.
    const selects = volDialog.locator('select')
    await selects.nth(0).selectOption(clusterId)
    await selects.nth(1).selectOption(volumeOfferingId)
    // The tier option reads the tier's name (VolumeCreateModal: <option value={o.id}>{o.name}</option>); an empty Size
    // stops the create with volumeCreate.sizeRequired before any request (VolumeCreateModal handleCreate:
    // !sizeGb ⇒ setError) — OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (volumeCreate.size, volumeCreate.sizeRequired).
    const offeringName = (await get('anonymous', '/v1/volume-offerings') as any[]).find((o) => o.id === volumeOfferingId).name as string
    expect(offeringName).toBe('Standard')
    await expect(selects.nth(1).locator(`option[value="${volumeOfferingId}"]`)).toHaveText(offeringName)
    await expect(volDialog.getByText('Size (GB)', { exact: true })).toBeVisible()
    await volDialog.getByRole('button', { name: 'Create volume' }).click()
    await expect(volDialog.getByText('Size is required.', { exact: true })).toBeVisible()
    await expect(volDialog).toHaveCount(1)
    await page.screenshot({ path: `${RESULTS}/UI-04-volume-size-required.png` })
    expect((await get('tenant', '/v1/tenant/volumes') as any[]).filter((v) => v.name === volumeName)).toEqual([])
    await volDialog.getByPlaceholder('e.g. 50').fill('1')
    await volDialog.getByRole('button', { name: 'Create volume' }).click()
    await expect(volDialog).toHaveCount(0)

    const createdVolume = await pollUntil('UI-04 volume appears in the list', () => get('tenant', '/v1/tenant/volumes') as Promise<any[]>,
      (rows) => rows.some((v) => v.name === volumeName), (rows) => `count=${rows.length}`)
    volumeId = createdVolume.find((v) => v.name === volumeName).id

    const volRowOf = () => page.getByRole('listitem').filter({ hasText: volumeName })
    await expect(volRowOf()).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-04-volume-created.png` })

    await waitVolume('UI-04 volume available', volumeId, (v) => v.status === 'Available')
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/volumes', { waitUntil: 'networkidle' })

    await volRowOf().getByRole('button', { name: 'Attach' }).click()
    const attachDialog = page.getByRole('dialog')
    // AttachVolumeDialog (OpenViCloud/titan-cloud-console:portal/src/pages/VolumeListPage.tsx) renders <option value={vm.id}>{vm.name} ({state})</option>: select by value (the
    // VM id) rather than by label, since the label's state suffix is not controlled by this test.
    await attachDialog.getByRole('combobox', { name: 'Select VM' }).selectOption(vmId)
    await attachDialog.getByRole('button', { name: 'Attach', exact: true }).click()
    await waitVolume('UI-04 volume attached', volumeId, (v) => v.currentAttachedVmId === vmId && v.status === 'Available')
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/volumes', { waitUntil: 'networkidle' })
    await expect(volRowOf()).toContainText('Attached')
    await page.screenshot({ path: `${RESULTS}/UI-04-volume-attached.png` })

    await volRowOf().getByRole('button', { name: 'Detach' }).click()
    await waitVolume('UI-04 volume detached', volumeId, (v) => v.currentAttachedVmId === null && v.status === 'Available')
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/volumes', { waitUntil: 'networkidle' })
    await expect(volRowOf()).toContainText('Available')

    await volRowOf().getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm' }).click()
    await waitVolume('UI-04 volume deleted', volumeId, (v) => v.status === 'Deleted')
    volumeId = ''
    log(`UI-04 vm-snapshot=${snapName} volume=${volumeName}`)
  })

  // titan-ops features/vm/design.md#requests-follow-incus ·
  // titan-ops features/vm/design.md#portal-refresh-after-mutation
  // OpenViCloud/titan-cloud-console:portal/src/components/vm/VmActions.tsx · OpenViCloud/titan-cloud-console:portal/src/lib/queryClient.ts (MutationCache invalidates ['activity'])
  test('UI-03 Stop, Start and Delete follow the Incus table, and the Dashboard feed refreshes after each mutation', async () => {
    test.skip(vmId === '', 'UI-02 did not create a VM')
    // A wait on the API may sign in again (auth.ts headersOf), which closes the old browser context: every wait
    // is followed by pageOf() again, and the locators are built on the current page.
    let page = await pageOf('tenant')
    const rowOf = () => page.getByRole('listitem').filter({ hasText: vmName })
    const feedOf = () => page.locator('main').getByRole('listitem').filter({ hasText: vmName })
    // Load the dashboard first so its activity query is cached — only then does a later client-side
    // navigation back to it prove the mutation's own invalidation worked, rather than a fresh page load.
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Virtual Machines' }).click()
    let row = rowOf()

    // Running/Ready → Stop is offered, Start is not.
    await expect(row.getByRole('button', { name: 'Stop' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Start' })).toHaveCount(0)
    await row.getByRole('button', { name: 'Stop' }).click()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview' }).click()
    // activityActions.vmStopRequested in OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts — the label a stop request's feed row carries.
    await expect(feedOf().filter({ hasText: /stop/i }).first()).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-03-stopped-feed.png` })
    await waitVm('UI-03 vm stopped', vmId, (v) => v.status === 'Stopped')
    page = await pageOf('tenant')

    // Stopped → Start is offered, Stop is not.
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Virtual Machines' }).click()
    row = rowOf()
    await expect(row.getByRole('button', { name: 'Start' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Stop' })).toHaveCount(0)
    await row.getByRole('button', { name: 'Start' }).click()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview' }).click()
    await expect(feedOf().filter({ hasText: /start/i }).first()).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-03-started-feed.png` })
    await waitVm('UI-03 vm started', vmId, runs)
    page = await pageOf('tenant')

    // Delete, through the row: the confirm dialog, the Deleting transition, then gone.
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    row = rowOf()
    await expect(row.getByRole('button', { name: 'Start' })).toHaveCount(0)
    await row.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('heading', { name: `Delete ${vmName}?` })).toBeVisible()
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(row.getByText('Deleting', { exact: true })).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-03-deleting.png` })
    await waitVm('UI-03 vm deleted', vmId, (v) => v.status === 'Deleted')
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    await expect(page.getByRole('listitem').filter({ hasText: vmName })).toHaveCount(0)
    vmId = ''

    const actions = await activityOf(vmName)
    log(`UI-03 activity ${vmName}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.stop_requested')).toBeGreaterThanOrEqual(1)
    expect(countOf(actions, 'vm.start_requested')).toBeGreaterThanOrEqual(1)
    expect(countOf(actions, 'vm.delete_requested')).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Group B: UI-05 (billing/invoices), UI-06 (wallet), UI-07 (buy credit), UI-08 (members/profile/legal). No VM.
// ---------------------------------------------------------------------------------------------------------------

test.describe.serial('portal-ui flows: billing, wallet and account pages', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-flows-account')
    useBrowser(browser)
    const page = await pageOf('tenant')
    // UI-05/UI-06 compare against English number formatting: force English regardless of the runner's IP
    // (titan-ops features/cloud-console/design.md#portal-language), independent of whatever UI-15 left behind.
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
  })

  test.afterAll(async () => {
    const page = await pageOf('tenant')
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    await closeSessions()
  })

  // titan-ops features/billing/invoice/design.md#invoice · OpenViCloud/titan-cloud-console:portal/src/pages/BillingPage.tsx · OpenViCloud/titan-cloud-console:portal/src/pages/InvoicesPage.tsx
  test('UI-05 Billing and Invoices show numbers formatted in English, matching the API', async () => {
    const before = await get('tenant', `/v1/tenant/billing/summary?month=${currentMonth()}`)
    const invoices = await get('tenant', '/v1/tenant/billing/invoices') as any[]
    // beta-user has no seeded invoice (billing/seed-invoices.sql seeds only admin-test) — the list is
    // expected empty here; UI-05's "invoice detail" half is reported NOT COVERED for this account.
    log(`UI-05 summary.totalCost=${before.totalCost} perVm=${before.perVm.length} invoices=${invoices.length}`)

    const page = await pageOf('tenant')
    let after = before
    await costShownMatches('UI-05',
      async () => {
        after = await get('tenant', `/v1/tenant/billing/summary?month=${currentMonth()}`)
        return after.totalCost
      },
      async () => {
        await page.goto(PORTAL + '/billing', { waitUntil: 'networkidle' })
        await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible()
        const text = await page.getByText('Total this month').locator('xpath=following-sibling::p[1]').textContent()
        await page.screenshot({ path: `${RESULTS}/UI-05-billing.png` })
        return text
      })
    for (const vm of after.perVm) {
      await expect(page.getByRole('row', { name: new RegExp(vm.vmName) })).toContainText(moneyEn(vm.totalCost))
    }

    await page.goto(PORTAL + '/billing/invoices', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1, name: 'Invoices' })).toBeVisible()
    if (invoices.length === 0) {
      await expect(page.getByText('No invoices yet')).toBeVisible()
    } else {
      // Each invoice's <tr> carries an explicit role="link" (OpenViCloud/titan-cloud-console:portal/src/pages/InvoicesPage.tsx), not the table's implicit
      // "row" — an explicit role attribute replaces the implicit one from the tag.
      const first = invoices[0]
      await expect(page.getByRole('link').filter({ hasText: moneyEn(first.total) })).toBeVisible()
    }
    await page.screenshot({ path: `${RESULTS}/UI-05-invoices.png` })
  })

  // titan-ops features/billing/wallet/design.md#wallet-portal · titan-ops architecture/money-and-wallet.md#confirmed-topup-is-receipt
  // OpenViCloud/titan-cloud-console:portal/src/pages/WalletPage.tsx (WalletPage: Receipts only when topUpEnabled === true;
  // StatementSection: statementEmptyHint only when topUpEnabled) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (wallet)
  test('UI-06 Wallet balance, statement and receipts match the API, in English formatting', async () => {
    const wallet = await get('tenant', '/v1/tenant/wallet')
    const statement = await get('tenant', '/v1/tenant/wallet/statement')
    const topups = await get('tenant', '/v1/tenant/topups') as any[]
    const receipts = topups.filter((t) => t.status === 'Confirmed')

    const page = await pageOf('tenant')
    const topUpEnabled = await topUpEnabledOf(PORTAL)
    log(`UI-06 topUpEnabled=${topUpEnabled} balance=${wallet.balance} statementLines=${statement.lines.length} receipts=${receipts.length}`)
    await page.goto(PORTAL + '/wallet', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible()
    // "Wallet balance" (StatCard) sits two ancestors above its label text (label → its row div → the card
    // div that also holds the value), distinct from the statement's "Balance" column, which uses the same
    // amount in a different row.
    const balanceCard = page.getByText('Wallet balance', { exact: true }).locator('xpath=ancestor::div[2]')
    await expect(balanceCard).toContainText(moneyEn(wallet.balance))
    await page.screenshot({ path: `${RESULTS}/UI-06-wallet.png` })

    if (statement.lines.length === 0) {
      await expect(page.getByText('No wallet activity yet')).toBeVisible()
      if (!topUpEnabled) {
        await expect(page.getByText('Buy credit to get started')).toHaveCount(0)
      }
    } else {
      await expect(page.getByRole('heading', { name: 'Statement' })).toBeVisible()
      // Statement and Receipts are two tables, one <section> each (OpenViCloud/titan-cloud-console:portal/src/pages/WalletPage.tsx StatementSection, ReceiptsSection).
      const statementSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Statement' }) })
      await expect(statementSection.getByRole('row')).toHaveCount(statement.lines.length + 1) // +1 header row
    }
    if (!topUpEnabled) {
      // No top-up on this env: the Receipts section is not rendered at all, whatever the top-up list holds.
      await expect(page.getByRole('heading', { name: 'Receipts' })).toHaveCount(0)
    } else if (receipts.length === 0) {
      await expect(page.getByText('No receipts yet')).toBeVisible()
    } else {
      // A receipt IS a Confirmed top-up (titan-ops architecture/money-and-wallet.md#confirmed-topup-is-receipt): its paymentRef is the row's reference.
      await expect(page.getByText(receipts[0].paymentRef)).toBeVisible()
      const receiptsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Receipts' }) })
      await expect(receiptsSection.getByRole('row')).toHaveCount(receipts.length + 1) // +1 header row
    }
  })

  // titan-ops features/billing/topup/design.md#topup-portal · OpenViCloud/titan-cloud-console:portal/src/pages/WalletPage.tsx (BuyCreditDialog)
  test('UI-07 Buy credit shows the transfer code; nothing is confirmed or paid', async () => {
    const page = await pageOf('tenant')
    test.skip(!(await topUpEnabledOf(PORTAL)), 'N/A: the portal config.json has no topUpEnabled: true (no Buy credit on this env)')
    await page.goto(PORTAL + '/wallet', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Buy credit' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Buy credit' })).toBeVisible()
    await dialog.getByLabel(/amount/i).fill('100000')
    await dialog.getByRole('button', { name: 'Continue' }).click()

    // The transfer memo (paymentRef) must appear — this IS the case (show the code), never a confirm/paid state.
    await expect(dialog.getByText('Transfer memo')).toBeVisible({ timeout: 30_000 })
    const memo = await dialog.locator('p.font-mono').last().textContent()
    expect(memo, 'a payment reference must be shown').toBeTruthy()
    await expect(dialog.getByRole('heading', { name: 'Credit added' })).toHaveCount(0)
    await page.screenshot({ path: `${RESULTS}/UI-07-buy-credit.png` })
    log(`UI-07 topup memo=${memo} (left Pending on purpose — no payment confirmed; residue reported, see README note)`)

    // Close without paying (Escape, not a button lookup: the dialog's icon-only [x] close control carries
    // no accessible name of its own, distinct from the unrelated ghost "Close" button only shown once a
    // webhook has confirmed or failed the payment). This top-up stays Pending — UI-07's rule is "never
    // confirm anything", and CLAUDE.md expects beta-user's wallet read-only outside this case.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // The unconfirmed top-up must not show as a receipt.
    const afterTopups = await get('tenant', '/v1/tenant/topups') as any[]
    const pending = afterTopups.find((t) => t.paymentRef === memo)
    expect(pending?.status).toBe('Pending')
  })

  // titan-ops features/legal/design.md#legal-ui · OpenViCloud/titan-cloud-console:portal/src/pages/MembersPage.tsx, OpenViCloud/titan-cloud-console:portal/src/pages/ProfilePage.tsx,
  // OpenViCloud/titan-cloud-console:portal/src/pages/LegalTermsPage.tsx
  test('UI-08 Members, Profile and the terms page show real content', async () => {
    const members = await get('tenant', '/v1/tenant/members') as any[]
    const tenant = await get('tenant', '/v1/tenant')
    log(`UI-08 members=${members.length} tenant=${tenant.name}/${tenant.status}`)

    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/members', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()
    if (members.length === 0) {
      await expect(page.getByText('No members yet')).toBeVisible()
    } else {
      await expect(page.getByText(members[0].keycloakUserId)).toBeVisible()
    }
    await page.screenshot({ path: `${RESULTS}/UI-08-members.png` })

    await page.goto(PORTAL + '/profile', { waitUntil: 'networkidle' })
    const main = page.locator('main')
    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
    // Scoped to <main>: the account menu in the top bar also shows the tenant name as accountLabel
    // (OpenViCloud/titan-cloud-console:portal/src/components/shell/AppShell.tsx), which would otherwise collide with an exact match on the page body.
    await expect(main.getByText(tenant.name, { exact: true })).toBeVisible()
    await expect(main.getByText(tenant.status, { exact: true })).toBeVisible()
    await expect(main.getByText(`${tenant.maxVms} machines`)).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-08-profile.png` })

    // The public terms page (no auth gate — OpenViCloud/titan-cloud-console:portal/src/App.tsx routes /legal before TenantProvider).
    const document = await get('anonymous', '/v1/legal/document?lang=en')
    const legalPage = await pageOf('tenant')
    await legalPage.goto(PORTAL + '/legal/terms', { waitUntil: 'networkidle' })
    await expect(legalPage.getByTestId('legal-terms')).toBeVisible()
    await expect(legalPage.getByRole('heading', { name: document.title })).toBeVisible()
    const version = await legalPage.getByTestId('legal-version').textContent()
    expect(version).toContain(document.version)
    await legalPage.screenshot({ path: `${RESULTS}/UI-08-legal-terms.png` })
    log(`UI-08 legal ${version}`)
  })

  // titan-ops features/billing/metering/design.md#usage-retention · OpenViCloud/titan-cloud-console:portal/src/pages/BillingPage.tsx (isExpired) ·
  // OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (usage.expired, usage.expiredInvoices) · OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (usage.expired, usage.expiredInvoices)
  test('UI-34 Billing shows last month as the API holds it and a month past 90 days as kept on the invoices only, in English then Vietnamese', async () => {
    const monthOf = (back: number): { key: string, first: Date } => {
      const now = new Date()
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
      return { key: `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}`, first }
    }
    const cutoff = Date.now() - 90 * 86_400_000
    const clicks = [1, 2, 3, 4].find((k) => monthOf(k).first.getTime() < cutoff)
    expect(clicks, 'a month starting before now − 90 days within four clicks back').toBeDefined()
    const previous = await get('tenant', `/v1/tenant/billing/summary?month=${monthOf(1).key}`)
    const expired = await call('tenant', 'GET', `/v1/tenant/billing/summary?month=${monthOf(clicks!).key}`)
    log(`UI-34 previous ${monthOf(1).key} totalCost=${previous.totalCost} perVm=${previous.perVm.length}; expired ${monthOf(clicks!).key} after ${clicks} clicks → ${expired.status} ${expired.text.slice(0, 200)}`)
    expect(bodyOf(expired).code, 'the summary of the expired month').toBe('USAGE_PERIOD_EXPIRED')

    const views = [
      { lang: 'en', locale: 'en-US', total: 'Total this month', back: 'Previous month', text: 'Detailed usage is kept for 90 days, so this month can no longer be shown.', link: 'See the invoices' },
      { lang: 'vi', locale: 'vi-VN', total: 'Tổng tháng này', back: 'Tháng trước', text: 'Mức sử dụng chi tiết chỉ được giữ 90 ngày, nên tháng này không còn xem được.', link: 'Xem hoá đơn' },
    ]
    const page = await pageOf('tenant')
    for (const view of views) {
      const money = (amount: number) => `${Math.round(amount).toLocaleString(view.locale)} ₫`
      await page.goto(PORTAL + '/billing', { waitUntil: 'networkidle' })
      await page.evaluate((lang) => localStorage.setItem('ovc-lang', lang), view.lang)
      await page.reload({ waitUntil: 'networkidle' })
      const main = page.locator('main')
      const back = page.getByRole('button', { name: view.back, exact: true })

      await back.click()
      const total = main.getByText(view.total, { exact: true }).locator('xpath=following-sibling::p[1]')
      await expect(total).toHaveText(money(previous.totalCost))
      for (const vm of previous.perVm) {
        await expect(main.getByRole('row', { name: new RegExp(vm.vmName) })).toContainText(money(vm.totalCost))
      }
      await page.screenshot({ path: `${RESULTS}/UI-34-previous-${view.lang}.png`, fullPage: true })

      for (let k = 2; k <= clicks!; k++) {
        await back.click()
      }
      // React Query retries a failed read before it reports the error: the sentence can take several seconds.
      await expect(main.getByText(view.text)).toBeVisible({ timeout: 30_000 })
      await expect(main.getByRole('link', { name: view.link, exact: true })).toHaveAttribute('href', '/billing/invoices')
      await expect(main.getByText(view.total, { exact: true })).toHaveCount(0)
      await expect(main.getByRole('table')).toHaveCount(0)
      expect(await main.textContent(), 'no ₫ on the expired month').not.toContain('₫')
      await expect(back).toBeDisabled()
      await page.screenshot({ path: `${RESULTS}/UI-34-expired-${view.lang}.png`, fullPage: true })
      log(`UI-34 ${view.lang}: previous month ${money(previous.totalCost)}, month ${monthOf(clicks!).key} shows the 90-day sentence`)
    }
    // The cases of this group compare English formatting; leave it English for any case added after this one.
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
  })
})
