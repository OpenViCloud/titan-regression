import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, call, expectStatus, get, log, pollUntil, startLog } from './api'
import { cleanUp } from './clean-up'
import { createVm, deleteVmAndWait, envOf, existenceShape, nameOf, waitNetwork, networkUsable, runs, waitVm } from './fixtures'

// Cases UI-16..17 of plan.md: a network with public IPv6 through the form, a VM on it, and a load
// balancer through its form. beta-user holds MaxNetworks = 1 (the shared run network, with no IPv6), so this
// module raises maxNetworks by one for its own second network and gives it back in afterAll — the exact pattern
// of load-balancer/load-balancer.spec.ts. Skips (not fails) when the cluster has no IPv6 block.

test.describe.serial('portal-ui flows: IPv6 network, VM and load balancer', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  const networkName = nameOf('net6ui')
  const vmName = nameOf('vm6ui')
  const lbName = nameOf('lb6ui')

  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null
  let networkId = ''
  let vmId = ''
  let lbId = ''
  let subnet = ''

  const readNetwork = () => get('tenant', `/v1/tenant/networks/${networkId}`)
  const readLb = (id: string) => get('tenant', `/v1/tenant/load-balancers/${id}`)

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(5 * 60_000)
    startLog('portal-ui-ipv6')
    useBrowser(browser)
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    originalQuota = { maxVms: tenant.maxVms, maxNetworks: tenant.maxNetworks }
    log(`quota before: ${JSON.stringify(originalQuota)}`)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    await cleanUp([
      ['load balancer', async () => {
        if (lbId === '') {
          return
        }
        const lb = await readLb(lbId)
        if (lb.desiredExistence === 'Exists') {
          await pollUntil('cleanup: load balancer at rest', () => readLb(lbId), (row) => row.transition === null, existenceShape)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
        }
        await pollUntil('cleanup: load balancer deleted', () => readLb(lbId), (row) => row.currentExistence === 'Deleted', existenceShape)
      }],
      ['vm', async () => {
        if (vmId !== '') {
          await deleteVmAndWait(vmId)
        }
      }],
      ['IPv6 network', async () => {
        if (networkId === '') {
          return
        }
        const network = await readNetwork()
        if (network.desiredExistence === 'Exists') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}`), 202)
        }
        await waitNetwork('cleanup: IPv6 network deleted', networkId, (n) => n.currentExistence === 'Deleted')
      }],
      ['quota', async () => {
        if (originalQuota !== null) {
          expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
          log(`quota restored: ${JSON.stringify(originalQuota)}`)
        }
      }],
      ['sessions', closeSessions],
    ])
  })

  // OpenViCloud/titan-ops:docs/features/network/design.md#ipv6-public · OpenViCloud/titan-ops:docs/features/cloud-console/design.md#quota-card
  // OpenViCloud/titan-cloud-console:portal/src/components/NetworkCreateModal.tsx · OpenViCloud/titan-cloud-console:portal/src/components/QuotaCard.tsx
  test('UI-16 a network with public IPv6 through the form, a VM on it, and the VM page showing its address', async () => {
    const { clusterId, smallTier, templateId } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    const block = clusters.find((c) => c.clusterId === clusterId)?.providerSettings?.ipv6Block ?? null
    log(`UI-16 cluster=${clusterId} ipv6Block=${block}`)
    test.skip(!block, 'the cluster has no IPv6 block configured')

    // A wait on the API may sign in again (auth.ts headersOf) and close the old context: pageOf() again after
    // every wait.
    let page = await pageOf('tenant')
    // Read the quota card BEFORE the new network exists, the same way OpenViCloud/titan-cloud-console:portal/src/components/QuotaCard.tsx itself counts (occupiesQuota
    // over the live network list) — not a hand-rolled filter that could drift from the component's own rule.
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    const ipv6RowOf = () => page.getByRole('region', { name: 'Quota' }).locator('[data-quota-row]').filter({ hasText: 'Public IPv6' })
    // The row's text runs the label into the count ("Public IPv60 / 10"): read the "<used> / <cap>" pair.
    const usedOf = (text: string | null) => Number(/(\d+)\s*\/\s*\d+/.exec(text ?? '')?.[1] ?? 'NaN')
    const ipv6Before = await ipv6RowOf().textContent()
    log(`UI-16 quota before: ${ipv6Before}`)

    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`,
      { maxVms: originalQuota!.maxVms, maxNetworks: originalQuota!.maxNetworks + 1 }), 204)
    await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create Network' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Create Network' })).toBeVisible()
    await dialog.getByPlaceholder('e.g. production-net').fill(networkName)
    // The Cluster <select> has a <label> with no htmlFor (OpenViCloud/titan-cloud-console:portal/src/components/NetworkCreateModal.tsx, Cluster field), so it carries no accessible
    // name — it is the dialog's only <select>, selected by position rather than by role name.
    await dialog.locator('select').selectOption(clusterId)
    await dialog.getByLabel('Enable public IPv6').check()
    await dialog.getByRole('button', { name: 'Create Network' }).click()
    await expect(dialog).toHaveCount(0)

    const networks = await get('tenant', '/v1/tenant/networks') as any[]
    const created = networks.find((n) => n.name === networkName)
    expect(created, 'the created network must be listed').not.toBeUndefined()
    networkId = created.id
    const settled = await waitNetwork('UI-16 network usable', networkId, networkUsable)
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
    subnet = settled.publicIpv6Subnet
    expect(subnet).toMatch(/\/64$/)
    log(`UI-16 network=${networkName} subnet=${subnet}`)

    const row = page.getByRole('listitem').filter({ hasText: networkName })
    await page.reload({ waitUntil: 'networkidle' })
    await expect(row).toContainText(subnet)
    await page.screenshot({ path: `${RESULTS}/UI-16-network-ipv6.png` })

    // Quota card: Public IPv6 used count increases by exactly one over what it read before this network existed
    // (OpenViCloud/titan-cloud-console:portal/src/components/QuotaCard.tsx's own occupiesQuota count, read from the page both times — not a parallel hand count that
    // could silently diverge from the component's rule).
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    const usedBefore = usedOf(ipv6Before)
    expect(usedBefore, `quota row read before: ${ipv6Before}`).not.toBeNaN()
    await expect(ipv6RowOf()).toContainText(`${usedBefore + 1} / `)
    await page.screenshot({ path: `${RESULTS}/UI-16-quota-ipv6.png` })

    // A VM on the IPv6 network: the VM page shows '—' before Incus reports an address, then the address itself.
    vmId = await createVm(vmName, smallTier, networkId)
    let vmPage = await pageOf('tenant')
    await vmPage.goto(PORTAL + `/vms/${vmId}`, { waitUntil: 'networkidle' })
    const publicIpv6Fact = vmPage.locator('dt', { hasText: 'Public IPv6' }).locator('xpath=following-sibling::dd[1]')
    await expect(publicIpv6Fact).toHaveText('—')
    await vmPage.screenshot({ path: `${RESULTS}/UI-16-vm-no-address-yet.png` })

    await waitVm('UI-16 vm running', vmId, runs)
    const vm = await pollUntil('UI-16 vm has public ipv6', () => get('tenant', `/v1/tenant/vms/${vmId}`),
      (v) => typeof v.publicIpv6Address === 'string', (v) => `publicIpv6Address=${v.publicIpv6Address}`)
    const prefix = subnet.replace(/::\/64$/, '')
    expect(vm.publicIpv6Address.startsWith(prefix)).toBe(true)
    vmPage = await pageOf('tenant')
    await vmPage.goto(PORTAL + `/vms/${vmId}`, { waitUntil: 'networkidle' })
    await expect(vmPage.locator('dt', { hasText: 'Public IPv6' }).locator('xpath=following-sibling::dd[1]')).toHaveText(vm.publicIpv6Address)
    await vmPage.screenshot({ path: `${RESULTS}/UI-16-vm-with-address.png` })
    log(`UI-16 vm=${vmName} publicIpv6=${vm.publicIpv6Address}`)
  })

  // OpenViCloud/titan-ops:docs/features/load-balancer/design.md#portal · OpenViCloud/titan-cloud-console:portal/src/pages/LoadBalancerListPage.tsx
  // OpenViCloud/titan-cloud-console:portal/src/components/LoadBalancerFormModal.tsx
  test('UI-17 create a load balancer through the form, edit its listeners, then delete it', async () => {
    test.skip(networkId === '' || vmId === '', 'UI-16 did not produce an IPv6 network and VM')
    // pageOf() again after every wait on the API: a sign-in closes the old context (auth.ts headersOf).
    let page = await pageOf('tenant')
    const rowOf = () => page.getByRole('listitem').filter({ hasText: lbName })
    const reopen = async () => {
      page = await pageOf('tenant')
      await page.goto(PORTAL + '/load-balancers', { waitUntil: 'networkidle' })
    }
    await page.goto(PORTAL + '/load-balancers', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create load balancer' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Create load balancer' })).toBeVisible()

    // The network select offers only networks with a /64 (OpenViCloud/titan-ops:docs/features/load-balancer/design.md#lb-needs-public-ipv6):
    // the shared run network (no IPv6) must not be an option, the IPv6 one from UI-16 must be. Its accessible
    // name is the field label "Network" (OpenViCloud/titan-cloud-console:portal/src/components/LoadBalancerFormModal.tsx, Network field) — "Select a network with public IPv6" is
    // only the placeholder <option> text, not an aria-label.
    const networkSelect = dialog.getByRole('combobox', { name: 'Network' })
    // allTextContents() does not auto-wait, so first wait for the option this test needs to actually appear
    // (the networks query having landed) before reading the full list to check what is absent from it.
    await expect(networkSelect.locator('option', { hasText: networkName })).toHaveCount(1)
    const optionLabels = await networkSelect.locator('option').allTextContents()
    const runNetworkRows = (await get('tenant', '/v1/tenant/networks') as any[]).filter((n) => n.name.startsWith('rg-net-'))
    for (const n of runNetworkRows) {
      expect(optionLabels).not.toContain(n.name)
    }

    await dialog.getByPlaceholder('e.g. web-lb').fill(lbName)
    await networkSelect.selectOption({ label: networkName })
    // One listener row is pre-filled TCP 80 → 80; change the target port to 8080 (TCP 80 → 8080). "Port" is
    // a case-insensitive substring of "Target port", so role-name matching needs exact: true throughout, or
    // .nth(1) on an unqualified 'Port' lookup silently grabs the wrong input.
    await dialog.getByRole('spinbutton', { name: 'Target port', exact: true }).fill('8080')
    await dialog.getByText(vmName).click()
    await dialog.getByRole('button', { name: 'Create load balancer' }).click()
    await expect(dialog).toHaveCount(0)

    const lbs = await get('tenant', '/v1/tenant/load-balancers') as any[]
    const created = lbs.find((lb) => lb.name === lbName)
    expect(created, 'the created load balancer must be listed').not.toBeUndefined()
    lbId = created.id

    await expect(rowOf()).toBeVisible()
    await expect(rowOf()).toContainText('IPv6 only')
    await expect(rowOf().getByText(/creating/i)).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-17-lb-creating.png` })

    const settled = await pollUntil('UI-17 load balancer on Incus', () => readLb(lbId),
      (lb) => lb.currentExistence === 'Exists' && lb.transition === null, existenceShape)
    expect(settled.vip).toBe(`${subnet.replace(/::\/64$/, '')}::1:1`)
    await reopen()
    await expect(rowOf()).toContainText(settled.vip)
    await expect(rowOf()).toContainText('TCP 80 → 8080')
    await expect(rowOf()).toContainText('1 VM')
    await expect(rowOf().getByText('Active', { exact: true })).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-17-lb-active.png` })
    log(`UI-17 ${lbName} vip=${settled.vip}`)

    // Edit: add a second listener (UDP 53 → 53).
    await rowOf().getByRole('button', { name: 'Edit' }).click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog.getByRole('heading', { name: 'Edit load balancer' })).toBeVisible()
    await editDialog.getByRole('button', { name: 'Add listener' }).click()
    const protocolSelects = editDialog.getByRole('combobox', { name: 'Protocol' })
    await protocolSelects.nth(1).selectOption('UDP')
    // exact: true on both — 'Port' is a substring of 'Target port', so an inexact lookup for 'Port' would
    // match both inputs' aria-labels and misassign .nth(1).
    const ports = editDialog.getByRole('spinbutton', { name: 'Port', exact: true })
    await ports.nth(1).fill('53')
    const targetPorts = editDialog.getByRole('spinbutton', { name: 'Target port', exact: true })
    await targetPorts.nth(1).fill('53')
    await editDialog.getByRole('button', { name: 'Save' }).click()
    await expect(editDialog).toHaveCount(0)

    const updated = await pollUntil('UI-17 load balancer updated', () => readLb(lbId),
      (lb) => lb.transition === null && lb.listeners.length === 2, existenceShape)
    expect(updated.listeners).toEqual(expect.arrayContaining([
      { protocol: 'TCP', port: 80, targetPort: 8080 },
      { protocol: 'UDP', port: 53, targetPort: 53 },
    ]))
    await reopen()
    await expect(rowOf()).toContainText('TCP 80 → 8080')
    await expect(rowOf()).toContainText('UDP 53 → 53')
    await page.screenshot({ path: `${RESULTS}/UI-17-lb-updated.png` })

    // Delete: Deleting badge, then the row disappears (LoadBalancerListPage renders from useLoadBalancers(),
    // which — like the API list used in LB-06 — drops a load balancer once it is Deleted).
    await rowOf().getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(rowOf().getByText(/deleting/i)).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-17-lb-deleting.png` })
    await pollUntil('UI-17 load balancer deleted', () => readLb(lbId), (lb) => lb.currentExistence === 'Deleted', existenceShape)
    await reopen()
    await expect(page.getByRole('listitem').filter({ hasText: lbName })).toHaveCount(0)
    log(`UI-17 ${lbName} deleted`)
  })
})
