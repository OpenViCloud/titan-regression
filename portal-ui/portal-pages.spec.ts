import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, get, log, startLog } from './api'
import { createVm, deleteVmAndWait, envOf, nameOf, runNetwork, runs, waitVm } from './fixtures'

// Cases UI-12..UI-14 of plan.md: the VM page, the top-bar search and the quota card.
// One small VM, created through the API, is the subject of all three; the page reads what the API reads.
test.describe.serial('portal-ui pages', () => {

  let vmId = ''
  const vmName = nameOf('vmui')

  // The hooks wait for a network and a VM on Incus: minutes, not the default 2. describe.configure does not
  // reach the hooks; setTimeout inside each hook does.
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('portal-ui-pages')
    useBrowser(browser)
    const { smallTier } = await envOf()
    const network = await runNetwork()
    vmId = await createVm(vmName, smallTier, network.id)
    await waitVm('ui vm running', vmId, runs)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    if (vmId !== '') {
      await deleteVmAndWait(vmId)
    }
    await closeSessions()
  })

  // titan-ops features/vm/design.md#vm-page · OpenViCloud/titan-cloud-console:portal/src/pages/VmDetailPage.tsx
  test('UI-12 Manage opens the VM page with the facts the API holds, and its snapshots tab', async () => {
    const vm = await get('tenant', `/v1/tenant/vms/${vmId}`)
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    const row = page.getByRole('listitem').filter({ hasText: vmName })
    await row.getByRole('link', { name: 'Manage' }).click()
    await expect(page).toHaveURL(new RegExp(`/vms/${vmId}$`))
    await expect(page.getByRole('heading', { name: vmName })).toBeVisible()
    await expect(page.getByText(vm.ipAddress as string)).toBeVisible()
    await expect(page.getByTestId('vm-cost')).toContainText('₫')
    await page.getByRole('tab', { name: 'Snapshots' }).click()
    await expect(page.getByText(/no snapshots/i)).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-12-vm-page.png` })
    log(`UI-12 ${vmName} ip=${vm.ipAddress}`)
  })

  // titan-ops features/cloud-console/design.md#global-search · OpenViCloud/titan-cloud-console:portal/src/components/shell/GlobalSearch.tsx
  test('UI-13 the top-bar search finds the VM by name and opens its page', async () => {
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    const box = page.getByRole('combobox', { name: /search vms, networks and volumes/i })
    await box.fill(vmName)
    await page.getByRole('option', { name: new RegExp(vmName) }).click()
    await expect(page).toHaveURL(new RegExp(`/vms/${vmId}$`))
    await page.screenshot({ path: `${RESULTS}/UI-13-search.png` })
    log('UI-13 search → VM page')
  })

  // titan-ops features/cloud-console/design.md#quota-card · OpenViCloud/titan-cloud-console:portal/src/lib/quota.ts
  test('UI-14 the quota card shows the caps the API returns and counts the live VM', async () => {
    const tenant = await get('tenant', '/v1/tenant')
    // Same rule as the card: wanted, and Incus holds it or its create still waits.
    const vms = await get('tenant', '/v1/tenant/vms') as Array<{ desiredExistence: string, currentExistence: string, transition: string | null }>
    const used = vms.filter((v) => v.desiredExistence === 'Exists'
      && (v.currentExistence === 'Exists' || (v.currentExistence === 'NotCreated' && v.transition !== null))).length
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    const card = page.getByRole('region', { name: 'Quota' })
    const vmRow = card.locator('[data-quota-row]').filter({ hasText: 'VMs' })
    await expect(vmRow).toContainText(`${used} / ${tenant.maxVms}`)
    await expect(card.locator('[data-quota-row]').filter({ hasText: 'Volumes' })).toContainText(`/ ${tenant.maxVolumes}`)
    await card.screenshot({ path: `${RESULTS}/UI-14-quota.png` })
    log(`UI-14 vms ${used}/${tenant.maxVms} volumes cap ${tenant.maxVolumes} ipv6 cap ${tenant.maxPublicIpv6}`)
  })
})
