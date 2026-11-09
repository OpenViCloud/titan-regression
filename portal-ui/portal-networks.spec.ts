import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { OBSERVED_WITHIN_MS, RESULTS, bodyOf, call, expectStatus, get, log, newKey, startLog } from './api'
import { cleanUp } from './clean-up'
import { envOf, nameOf, networkUsable, waitNetwork } from './fixtures'

// Cases UI-30..31 of plan.md: rename a network through its dialog, then delete it through the confirm dialog.
// The network is this spec's own (no VM, no load balancer): beta-user holds MaxNetworks = 1 (the shared run
// network), so the spec raises maxNetworks by one before creating it and gives the quota back in afterAll — the
// pattern of portal-ipv6.spec.ts. afterAll also deletes the network if the cases stopped before their own delete.
const NETUI_CIDR = '10.86.0.0/24' // apart from every other CIDR the specs use

test.describe.serial('portal-ui networks: rename and delete', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  const firstName = nameOf('netui')
  const secondName = nameOf('netui2')

  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null
  let networkId = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('portal-ui-networks')
    useBrowser(browser)
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    originalQuota = { maxVms: tenant.maxVms, maxNetworks: tenant.maxNetworks }
    log(`quota before: ${JSON.stringify(originalQuota)}`)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`,
      { maxVms: originalQuota.maxVms, maxNetworks: originalQuota.maxNetworks + 1 }), 204)
    const { clusterId } = await envOf()
    const created = await call('tenant', 'POST', '/v1/tenant/networks', { name: firstName, clusterId, cidr: NETUI_CIDR }, newKey())
    expectStatus(created, 202)
    networkId = bodyOf(created).networkId as string
    await waitNetwork('netui created', networkId, networkUsable)
    // English strings below, whatever the runner's IP (titan-ops features/cloud-console/design.md#portal-language).
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    await cleanUp([
      ['network', async () => {
        if (networkId === '') {
          return
        }
        const network = await get('tenant', `/v1/tenant/networks/${networkId}`)
        if (network.status !== 'Deleting' && network.status !== 'Deleted') {
          // NetworkStatus: Creating, Deleting are in flight; everything else is at rest.
          await waitNetwork('cleanup: network at rest', networkId, (n) => n.status !== 'Creating' && n.status !== 'Deleting')
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}`), 202)
        }
        await waitNetwork('cleanup: network deleted', networkId, (n) => n.status === 'Deleted')
      }],
      ['quota', async () => {
        if (originalQuota !== null) {
          expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
          log(`quota restored: ${JSON.stringify(originalQuota)}`)
        }
      }],
      ['language', async () => {
        const page = await pageOf('tenant')
        await page.evaluate(() => localStorage.removeItem('ovc-lang'))
      }],
      ['sessions', closeSessions],
    ])
  })

  // titan-ops features/network/user-stories.md#us-net-rename-02
  // OpenViCloud/titan-cloud-console:portal/src/pages/NetworkListPage.tsx (RenameNetworkDialog: name starts as network.name, canSave =
  // trimmed non-empty and different; handleSave closes the dialog and toasts networks.renamed) · OpenViCloud/titan-cloud-console:portal/src/hooks/useNetworks.ts
  // (useRenameNetwork: PATCH /v1/tenant/networks/{id} body {name}, then invalidates the list) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts
  // (networks.renameTitle, networks.renamed) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/RenameNetworkEndpoint.cs
  // (RenameNetworkEndpoint: SendNoContentAsync)
  test('UI-30 Rename: prefilled, Save only for a new non-empty name, PATCH {name} is 204, the row shows it without a reload', async () => {
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
    // A marker a reload would wipe: the new name must show without one.
    await page.evaluate(() => { (window as any).__rgNoReload = true })
    const rowOf = (name: string) => page.getByRole('list', { name: 'Networks' }).getByRole('listitem')
      .filter({ has: page.getByText(name, { exact: true }) })
    await rowOf(firstName).getByRole('button', { name: 'Rename', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Rename network' })).toBeVisible()
    const field = dialog.locator('#network-name')
    const save = dialog.getByRole('button', { name: 'Save', exact: true })
    await expect(field).toHaveValue(firstName)
    await expect(save).toBeDisabled()
    await field.fill('')
    await expect(save).toBeDisabled()
    await field.fill(secondName)
    await expect(save).toBeEnabled()
    await page.screenshot({ path: `${RESULTS}/UI-30-rename-dialog.png` })

    const patched = page.waitForResponse((res) => res.request().method() === 'PATCH'
      && res.url().endsWith(`/v1/tenant/networks/${networkId}`))
    await save.click()
    const response = await patched
    expect(response.request().postDataJSON()).toEqual({ name: secondName })
    expect(response.status()).toBe(204)
    await expect(page.getByText('Network renamed')).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await expect(rowOf(secondName)).toHaveCount(1)
    await expect(rowOf(firstName)).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__rgNoReload === true), 'the page was not reloaded').toBe(true)
    await page.screenshot({ path: `${RESULTS}/UI-30-renamed.png` })

    const network = await get('tenant', `/v1/tenant/networks/${networkId}`)
    expect(network.name).toBe(secondName)
    log(`UI-30 ${networkId} renamed ${firstName} → ${secondName}, PATCH 204`)
  })

  // titan-ops features/network/user-stories.md#us-p09
  // OpenViCloud/titan-cloud-console:portal/src/components/DeleteConfirmDialog.tsx (DeleteConfirmDialog: deleteDialog.title(name),
  // deleteDialog.description, Cancel is a DialogClose, Confirm calls onConfirm) · OpenViCloud/titan-cloud-console:portal/src/pages/NetworkListPage.tsx
  // (NetworkListPage: Delete enabled by canDeleteIncusResource with no VM or load balancer; handleConfirmDelete toasts networks.deleted)
  // · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (deleteDialog, networks.deleted) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Network/DeleteNetworkEndpoint.cs
  // (DeleteNetworkEndpoint: 202) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/NetworkRepository.cs (ListByTenantAsync:
  // a Deleted network is not listed)
  test('UI-31 Delete: Cancel sends nothing; Confirm sends DELETE ⇒ 202, toast, and the network leaves the list', async () => {
    test.skip(networkId === '', 'beforeAll did not create the network')
    const before = await get('tenant', `/v1/tenant/networks/${networkId}`)
    expect(before.name, 'UI-30 renamed it').toBe(secondName)
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
    const deletes: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/v1/tenant/networks/')) deletes.push(req.url())
    })
    const row = page.getByRole('list', { name: 'Networks' }).getByRole('listitem')
      .filter({ has: page.getByText(secondName, { exact: true }) })
    const deleteButton = row.getByRole('button', { name: 'Delete', exact: true })
    await expect(deleteButton).toBeEnabled()

    await deleteButton.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: `Delete ${secondName}?` })).toBeVisible()
    await expect(dialog.getByText('This action cannot be undone. The resource will be permanently deleted.', { exact: true })).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-31-confirm.png` })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(deletes, 'Cancel sends no DELETE').toEqual([])
    await expect(row).toHaveCount(1)

    await deleteButton.click()
    await expect(dialog.getByRole('heading', { name: `Delete ${secondName}?` })).toBeVisible()
    const deleted = page.waitForResponse((res) => res.request().method() === 'DELETE'
      && res.url().endsWith(`/v1/tenant/networks/${networkId}`))
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    const response = await deleted
    expect(response.status()).toBe(202)
    expect(deletes.length, 'one DELETE for one Confirm').toBe(1)
    await expect(page.getByText('Network deleted')).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-31-deleted.png` })

    // The list re-reads every 5 s while a row waits (pollWhileIncusWaits) and drops the network once it is Deleted.
    await expect(row).toHaveCount(0, { timeout: OBSERVED_WITHIN_MS })
    await waitNetwork('UI-31 network deleted', networkId, (n) => n.status === 'Deleted')
    const networks = await get('tenant', '/v1/tenant/networks') as any[]
    expect(networks.some((n) => n.id === networkId), 'GET /v1/tenant/networks no longer lists it').toBe(false)
    log(`UI-31 ${secondName} deleted: DELETE 202, row gone, not listed`)
  })
})
