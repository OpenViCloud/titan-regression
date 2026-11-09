import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, get, log, startLog } from './api'
import { cleanUp } from './clean-up'
import { createVm, deleteVmAndWait, envOf, nameOf, runNetwork, runs, waitVm } from './fixtures'

// Cases UI-12..UI-14 and UI-29 of plan.md: the VM page, the top-bar search, the quota card and the run network's
// row while the VM lives on it. One small VM, created through the API, is the subject of all four; the page reads
// what the API reads.
test.describe.serial('portal-ui pages', () => {

  let vmId = ''
  let networkId = ''
  const vmName = nameOf('vmui')

  // The hooks wait for a network and a VM on Incus: minutes, not the default 2. describe.configure does not
  // reach the hooks; setTimeout inside each hook does.
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('portal-ui-pages')
    useBrowser(browser)
    const { smallTier } = await envOf()
    const network = await runNetwork()
    networkId = network.id
    vmId = await createVm(vmName, smallTier, network.id)
    await waitVm('ui vm running', vmId, runs)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    await cleanUp([
      ['vm', async () => {
        if (vmId !== '') {
          await deleteVmAndWait(vmId)
        }
      }],
      // UI-29 switches the language; leave none picked, so the next spec starts from the default.
      ['language', async () => {
        const page = await pageOf('tenant')
        await page.evaluate(() => localStorage.removeItem('ovc-lang'))
      }],
      ['sessions', closeSessions],
    ])
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
    // Same rule as the card (OpenViCloud/titan-cloud-console:portal/src/lib/quota.ts vmOccupiesQuota): every status but
    // Deleting, Deleted, NotFound and Failed.
    const vms = await get('tenant', '/v1/tenant/vms') as Array<{ status: string }>
    const used = vms.filter((v) => v.status !== 'Deleting' && v.status !== 'Deleted' && v.status !== 'NotFound' && v.status !== 'Failed').length
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    const card = page.getByRole('region', { name: 'Quota' })
    const vmRow = card.locator('[data-quota-row]').filter({ hasText: 'VMs' })
    await expect(vmRow).toContainText(`${used} / ${tenant.maxVms}`)
    await expect(card.locator('[data-quota-row]').filter({ hasText: 'Volumes' })).toContainText(`/ ${tenant.maxVolumes}`)
    await card.screenshot({ path: `${RESULTS}/UI-14-quota.png` })
    log(`UI-14 vms ${used}/${tenant.maxVms} volumes cap ${tenant.maxVolumes} ipv6 cap ${tenant.maxPublicIpv6}`)
  })

  // titan-ops features/network/user-stories.md#us-p07 · titan-ops features/network/user-stories.md#us-p09
  // OpenViCloud/titan-cloud-console:portal/src/pages/NetworkListPage.tsx (NetworkListPage: row name, incusLabel badge, `cidr ?? '—'`,
  // `gateway ?? '—'`, clusterMap name · networks.createdOn(f.date(createdAt)); Delete disabled while attachedNetworkIds holds the
  // network, title deleteBlockedTitle) · OpenViCloud/titan-cloud-console:portal/src/lib/networkState.ts (incusLabel: status verbatim,
  // "Not found" for NotFound) · OpenViCloud/titan-cloud-console:portal/src/lib/vmState.ts (holdsItsNetwork: every status but Deleted,
  // NotFound, Failed) · OpenViCloud/titan-cloud-console:portal/src/lib/money.ts (formatDate) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts,
  // OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (networks.removeVmsFirst, networks.createdOn, networks.listLabel, common.delete)
  test('UI-29 the run network row shows the API facts and holds Delete back while its VM lives, in English then Vietnamese', async () => {
    const network = await get('tenant', `/v1/tenant/networks/${networkId}`)
    // NetworkStatus: Creating, Deleting are in flight; the run network, long in use, must rest in one of the others.
    expect(['Creating', 'Deleting'], 'the run network rests, so its badge is the Incus word').not.toContain(network.status)
    const clusters = await get('anonymous', '/v1/clusters') as Array<{ id: string, name: string }>
    const clusterName = clusters.find((c) => c.id === network.clusterId)?.name
    expect(clusterName, `GET /v1/clusters lists ${network.clusterId}`).toBeTruthy()
    log(`UI-29 ${network.name} status=${network.status} cidr=${network.cidr} gateway=${network.gateway} cluster=${clusterName}`)

    const page = await pageOf('tenant')
    const deletes: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/v1/tenant/networks/')) deletes.push(req.url())
    })
    const views = [
      { lang: 'en', list: 'Networks', created: 'created', remove: 'Delete', blocked: 'Remove all VMs first' },
      { lang: 'vi', list: 'Mạng', created: 'tạo ngày', remove: 'Xoá', blocked: 'Xoá hết máy ảo trong mạng trước' },
    ]
    for (const view of views) {
      await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
      await page.evaluate((lang) => localStorage.setItem('ovc-lang', lang), view.lang)
      await page.reload({ waitUntil: 'networkidle' })
      // The date the portal prints, computed in the page so the browser's time zone applies to both sides.
      const date = await page.evaluate(([iso, lang]) => {
        const d = new Date(iso)
        if (lang === 'vi') {
          const two = (n: number) => String(n).padStart(2, '0')
          return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`
        }
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      }, [network.createdAt as string, view.lang])
      const row = page.getByRole('list', { name: view.list }).getByRole('listitem')
        .filter({ has: page.getByText(network.name, { exact: true }) })
      await expect(row).toHaveCount(1)
      // incusLabel: the status verbatim, "Not found" (space) only for NotFound.
      await expect(row.getByText(network.status === 'NotFound' ? 'Not found' : network.status, { exact: true })).toBeVisible()
      await expect(row.getByText('CIDR', { exact: true }).locator('xpath=following-sibling::p[1]')).toHaveText(network.cidr ?? '—')
      await expect(row.getByText('Gateway', { exact: true }).locator('xpath=following-sibling::p[1]')).toHaveText(network.gateway ?? '—')
      await expect(row.getByText(`${clusterName} · ${view.created} ${date}`, { exact: true })).toBeVisible()
      const deleteButton = row.getByRole('button', { name: view.remove, exact: true })
      await expect(deleteButton).toBeDisabled()
      await expect(deleteButton).toHaveAttribute('title', view.blocked)
      // A disabled button fires no click: forcing one proves nothing is sent and no confirm dialog opens.
      await deleteButton.click({ force: true })
      await page.waitForTimeout(500)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.screenshot({ path: `${RESULTS}/UI-29-networks-${view.lang}.png` })
      log(`UI-29 ${view.lang}: row matches the API, Delete disabled with "${view.blocked}"`)
    }
    expect(deletes, 'no DELETE /v1/tenant/networks/… from the page').toEqual([])
  })
})
