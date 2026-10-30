import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, bodyOf, call, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { envOf, nameOf, runNetwork, runs, waitVm, waitVolume } from './fixtures'
import { topUpEnabledOf } from './portal-config'

// Cases UI-18..21, UI-24..26 of plan.md: form validation (network, VM, firewall rule), the buy-credit
// amount parser, the VM delete button's existence/transition invariant, deleting a volume that still has a
// snapshot, and the 404 page. UI-18 is N/A where the portal config has no topUpEnabled: true. UI-22 is NOT COVERED
// (plan.md says why: needs a provider-refused delete, no fault injection on any environment).
//
// POLL_MS — OpenViCloud/titan-cloud-console:portal/src/hooks/pollUntilSettled.ts — is the interval the VM list page itself refetches at
// while a row is waiting, used below to size how long an "enabled" assertion is given to catch up with it.
//
// UI-23 (network with a load balancer and no VM blocks Delete with "Delete the load balancers of this network
// first") is also NOT COVERED: a load balancer requires at least one backend VM
// (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/LoadBalancer/LoadBalancerSpecRules.cs BackendsAreValid — count
// must be 1..MaxBackends), and that VM must sit on the load balancer's own network
// (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs BeginLoadBalancerBackend requires
// NetworkId == networkId). While the load balancer lives, deleting that VM is refused
// (OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/DeleteVmCommandHandler.cs HandleAsync, VM_IS_LOAD_BALANCER_BACKEND),
// so the network always has a live VM on it too.
// OpenViCloud/titan-cloud-console:portal/src/pages/NetworkListPage.tsx (deleteBlockedTitle) checks attachedNetworkIds before networksWithALoadBalancer, so the title shown would be
// "Remove all VMs first" (t.networks.removeVmsFirst), never the load-balancer title the case asks for.

test.describe.serial('portal-ui forms: network, firewall, volume and VM form validation', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  let volumeId = ''
  let vmId20 = ''
  let ruleId = ''
  let runNetworkId = ''
  let runNetworkName = ''
  const vmName20 = nameOf('vmui20')
  const volumeName = nameOf('volui21')
  const ruleCidr = '203.0.113.5/32' // TEST-NET-3 (RFC 5737): distinctive, never collides with another rule's CIDR

  // Same shape as volume/volume.spec.ts and portal-flows.spec.ts's deleteVolumeAndWait: drain attach
  // and snapshots first, since a DELETE on a volume that still has one 422s with VOLUME_HAS_SNAPSHOTS — the very
  // refusal UI-21 means to exercise, so cleanup must not race it.
  async function deleteVolumeAndWait(id: string): Promise<void> {
    const volume = await waitVolume(`cleanup: volume ${id} at rest`, id, (v) => v.transition === null || v.currentExistence === 'Deleted')
    if (volume.currentExistence === 'Deleted') {
      return
    }
    if (volume.currentAttachedVmId !== null) {
      expectStatus(await call('tenant', 'POST', `/v1/tenant/volumes/${id}/detach`), 202)
      await waitVolume('cleanup: detached', id, (v) => v.currentAttachedVmId === null && v.transition === null)
    }
    const snaps = await get('tenant', `/v1/tenant/volumes/${id}/snapshots`) as any[]
    for (const snap of snaps) {
      if (snap.desiredExistence === 'Exists') {
        await pollUntil('cleanup: snapshot at rest', () => get('tenant', `/v1/tenant/volumes/${id}/snapshots`).then((rows: any[]) => rows.find((s) => s.id === snap.id)),
          (s) => s === undefined || s.transition === null, (s) => `transition=${s?.transition}`)
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${id}/snapshots/${snap.id}`), 202)
      }
    }
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${id}`), 202)
    await waitVolume('cleanup: volume deleted', id, (v) => v.currentExistence === 'Deleted')
  }

  async function deleteVmAndWait(id: string): Promise<void> {
    // A delete while the create is still waiting without an instance yet is refused (VM_INVALID_STATUS,
    // titan-ops features/vm/design.md#requests-follow-incus); wait past that window first.
    const vm = await waitVm(`cleanup: vm ${id} out of NotCreated`, id,
      (v) => v.currentExistence !== 'NotCreated' || v.transition === null || v.currentExistence === 'Deleted')
    if (vm.currentExistence === 'Deleted') {
      return
    }
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${id}`), 202)
    await waitVm('cleanup: vm deleted', id, (v) => v.currentExistence === 'Deleted')
  }

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-forms')
    useBrowser(browser)
    // UI-19/24/25 compare against literal English strings; force English regardless of the runner's IP
    // (titan-ops features/cloud-console/design.md#portal-language), independent of what UI-15/18/26 leave behind.
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
  })

  test.afterAll(async () => {
    test.setTimeout(15 * 60_000)
    if (ruleId !== '' && runNetworkId !== '') {
      // A firewall rule carries no name, so cleanup (cleanup) cannot sweep it by rg- prefix: this
      // module deletes its own rule. A delete while the rule is still Creating is refused
      // (FIREWALL_RULE_NOT_READY) — wait for it to rest first.
      const rule = await pollUntil('cleanup: firewall rule at rest', () => get('tenant', `/v1/tenant/networks/${runNetworkId}/firewall-rules`),
        (rows: any[]) => {
          const row = rows.find((r) => r.id === ruleId)
          return row === undefined || row.transition === null
        }, (rows: any[]) => `count=${rows.length}`)
      const stillThere = rule.find((r: any) => r.id === ruleId)
      if (stillThere !== undefined && stillThere.currentExistence !== 'Deleted') {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${runNetworkId}/firewall-rules/${ruleId}`), 204)
        await pollUntil('cleanup: firewall rule gone', () => get('tenant', `/v1/tenant/networks/${runNetworkId}/firewall-rules`),
          (rows: any[]) => {
            const row = rows.find((r) => r.id === ruleId)
            return row === undefined || row.currentExistence === 'Deleted'
          }, (rows: any[]) => `count=${rows.length}`)
      }
    }
    if (volumeId !== '') {
      await deleteVolumeAndWait(volumeId)
    }
    if (vmId20 !== '') {
      await deleteVmAndWait(vmId20)
    }
    const page = await pageOf('tenant')
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    await closeSessions()
  })

  // titan-ops features/network/design.md#network-portal · OpenViCloud/titan-cloud-console:portal/src/components/NetworkCreateModal.tsx
  // (clusterRequired, shown under the field) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (networkCreate.clusterRequired)
  test('UI-19 Create Network with no cluster shows a field error and sends no request', async () => {
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create Network' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Create Network' })).toBeVisible()
    await dialog.getByPlaceholder('e.g. production-net').fill(nameOf('netnocluster'))

    let posted = false
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/v1/tenant/networks')) posted = true
    })
    await dialog.getByRole('button', { name: 'Create Network' }).click()
    await expect(dialog.getByText('Choose a cluster')).toBeVisible()
    await page.waitForTimeout(500) // give a wrongly-sent request a moment to show up before asserting its absence
    expect(posted, 'no POST should be sent while the cluster field is in error').toBe(false)
    await expect(dialog).toBeVisible() // the dialog stays open — the create was never attempted
    await page.screenshot({ path: `${RESULTS}/UI-19-cluster-required.png` })
    await page.keyboard.press('Escape')
    log('UI-19 "Choose a cluster" shown, no POST sent')
  })

  // titan-ops features/vm/design.md#vm-portal · OpenViCloud/titan-cloud-console:portal/src/components/VmCreateModal.tsx
  // (choicesRequired, shown as apiError when the template is left empty) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (vmCreate.choicesRequired)
  test('UI-24 Create VM with no template shows "Choose a cluster, network, template and size." and sends no request', async () => {
    await runNetwork() // the Network select must offer at least one usable network, or Create VM stays disabled
    const { clusterId, smallTier } = await envOf()
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create VM' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Create Virtual Machine' })).toBeVisible()
    await dialog.getByPlaceholder('e.g. web-server-01').fill(nameOf('vmnotpl'))
    await dialog.getByRole('combobox', { name: 'Cluster' }).selectOption(clusterId)
    const network = await runNetwork()
    await dialog.getByRole('combobox', { name: 'Network' }).selectOption(network.id)
    // Template left at its placeholder ('') on purpose; Size is filled so only the template is missing.
    await dialog.getByRole('combobox', { name: 'Size' }).selectOption(smallTier)

    let posted = false
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/v1/tenant/vms')) posted = true
    })
    await dialog.getByRole('button', { name: 'Create VM' }).click()
    await expect(dialog.getByText('Choose a cluster, network, template and size.')).toBeVisible()
    await page.waitForTimeout(500)
    expect(posted, 'no POST should be sent while a required choice is missing').toBe(false)
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-24-template-required.png` })
    await page.keyboard.press('Escape')
    log('UI-24 choicesRequired message shown, no POST sent')
  })

  // titan-ops features/network/design.md#network-portal · OpenViCloud/titan-cloud-console:portal/src/pages/NetworkListPage.tsx
  // (FirewallRuleCreateForm: one port typed, End Port empty, becomes startPort=endPort; startPortRequired when
  // Start Port is empty; the CIDR <label> carries no htmlFor, so it is found by placeholder, not getByLabel)
  // OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (firewall.addRule: toggle button "Add Rule"; firewall.submit: submit button "Add rule")
  test('UI-25 a TCP rule with only Start Port sends startPort=endPort=8080; a second with no Start Port is refused client-side', async () => {
    const network = await runNetwork()
    runNetworkId = network.id
    runNetworkName = network.name
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
    // Exact name, not a prefix match: an older run's network can still be listed on a long-lived test tenant,
    // and one run's name could otherwise be a prefix of another's.
    const row = page.getByRole('listitem').filter({ has: page.getByText(runNetworkName, { exact: true }) })
    await row.getByRole('button', { name: 'Firewall' }).click()
    await page.getByRole('button', { name: 'Add Rule' }).click()
    const submitButton = page.getByRole('button', { name: 'Add rule', exact: true })

    // Attempt 1: TCP, CIDR filled, Start Port 8080, End Port left blank.
    await page.getByPlaceholder('e.g. 0.0.0.0/0').fill(ruleCidr)
    await page.getByLabel('Start Port', { exact: true }).fill('8080')

    const postPromise = page.waitForRequest((req) =>
      req.method() === 'POST' && req.url().includes(`/v1/tenant/networks/${runNetworkId}/firewall-rules`))
    await submitButton.click()
    const firstRequest = await postPromise
    const firstBody = firstRequest.postDataJSON()
    expect(firstBody.startPort).toBe(8080)
    expect(firstBody.endPort).toBe(8080)
    expect(firstBody.cidr).toBe(ruleCidr)

    const createdRule = await pollUntil('UI-25 rule appears', () => get('tenant', `/v1/tenant/networks/${runNetworkId}/firewall-rules`),
      (rows: any[]) => rows.some((r) => r.cidr === ruleCidr), (rows: any[]) => `count=${rows.length}`)
    ruleId = createdRule.find((r: any) => r.cidr === ruleCidr).id
    const ruleRow = page.getByTestId('firewall-rule-row').filter({ hasText: ruleCidr })
    await expect(ruleRow).toContainText('8080')
    await page.screenshot({ path: `${RESULTS}/UI-25-rule-created.png` })
    log(`UI-25 rule ${ruleId} startPort=endPort=8080`)

    // Attempt 2: a second TCP rule with Start Port left empty is refused before any request is sent.
    await page.getByRole('button', { name: 'Add Rule' }).click()
    await page.getByPlaceholder('e.g. 0.0.0.0/0').fill('203.0.113.6/32')
    let secondPosted = false
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('firewall-rules')) secondPosted = true
    })
    await page.getByRole('button', { name: 'Add rule', exact: true }).click()
    await expect(page.getByText('Start Port is required for TCP and UDP.')).toBeVisible()
    await page.waitForTimeout(500)
    expect(secondPosted, 'no POST should be sent when Start Port is required and missing').toBe(false)
    await page.screenshot({ path: `${RESULTS}/UI-25-start-port-required.png` })
    log('UI-25 second rule refused client-side, no POST sent')
  })

  // titan-ops features/volume/design.md#volume-portal · OpenViCloud/titan-cloud-console:portal/src/pages/VolumeListPage.tsx
  // (handleConfirmDelete: VOLUME_HAS_SNAPSHOTS → t.volumes.hasSnapshots toast; dialog closes via setDeleteTarget(null) either way)
  // OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (volumes.hasSnapshots)
  test('UI-21 deleting a volume that still has a snapshot is refused, the dialog closes, the volume stays', async () => {
    const { clusterId, volumeOfferingId } = await envOf()
    const created = await call('tenant', 'POST', '/v1/tenant/volumes',
      { name: volumeName, volumeOfferingId, clusterId, sizeGb: 1 }, newKey())
    expectStatus(created, 202)
    volumeId = bodyOf(created).volumeId as string
    await pollUntil('UI-21 volume ready', () => get('tenant', '/v1/tenant/volumes').then((rows: any[]) => rows.find((v) => v.id === volumeId)),
      (v) => v.currentExistence === 'Exists' && v.transition === null, (v) => `existence=${v.currentExistence} transition=${v.transition}`)

    const snapReply = await call('tenant', 'POST', `/v1/tenant/volumes/${volumeId}/snapshots`, { name: nameOf('volsnap21') }, newKey())
    expectStatus(snapReply, 202)
    const snapshotId = bodyOf(snapReply).snapshotId as string
    await pollUntil('UI-21 snapshot ready', () => get('tenant', `/v1/tenant/volumes/${volumeId}/snapshots`).then((rows: any[]) => rows.find((s) => s.id === snapshotId)),
      (s) => s.currentExistence === 'Exists' && s.transition === null, (s) => `existence=${s.currentExistence} transition=${s.transition}`)

    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/volumes', { waitUntil: 'networkidle' })
    const row = page.getByRole('listitem').filter({ hasText: volumeName })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('heading', { name: `Delete ${volumeName}?` })).toBeVisible()
    await page.getByRole('button', { name: 'Confirm' }).click()

    await expect(page.getByText('still has snapshots')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0) // the confirm dialog closes regardless of outcome
    await page.screenshot({ path: `${RESULTS}/UI-21-still-has-snapshots.png` })

    const volume = await get('tenant', '/v1/tenant/volumes').then((rows: any[]) => rows.find((v) => v.id === volumeId))
    expect(volume.currentExistence, 'the volume must still exist').toBe('Exists')
    log(`UI-21 volume ${volumeName} survives delete attempt while it has a snapshot`)
  })

  // titan-ops features/vm/design.md#vm-portal · OpenViCloud/titan-cloud-console:portal/src/lib/vmState.ts (canDeleteVm: false while Deleting, and while
  // transition === 'Creating' && currentExistence === 'NotCreated'; true once Exists, even mid-Creating)
  // OpenViCloud/titan-cloud-console:portal/src/components/vm/VmActions.tsx (VmActions: Delete disabled by canDeleteVm)
  // OpenViCloud/titan-cloud-console:portal/src/hooks/pollUntilSettled.ts (POLL_MS = 5000,
  // the interval the VM list itself refetches at while a row waits)
  test('UI-20 creating a VM through the form: Delete is disabled only while Creating and NotCreated, enabled once Exists', async () => {
    const POLL_MS = 5_000
    const { clusterId, templateId, smallTier } = await envOf()
    const network = await runNetwork()
    let page = await pageOf('tenant')
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create VM' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Create Virtual Machine' })).toBeVisible()
    await dialog.getByPlaceholder('e.g. web-server-01').fill(vmName20)
    await dialog.getByRole('combobox', { name: 'Cluster' }).selectOption(clusterId)
    await dialog.getByRole('combobox', { name: 'Network' }).selectOption(network.id)
    await dialog.getByRole('combobox', { name: 'Template' }).selectOption(templateId)
    await dialog.getByRole('combobox', { name: 'Size' }).selectOption(smallTier)
    await dialog.getByRole('button', { name: 'Create VM' }).click()
    await expect(dialog).toHaveCount(0)

    // Read the id back right away, before any further assertion, so a later failure still leaves cleanup able
    // to find and delete the VM.
    const created = await pollUntil('UI-20 vm appears in the list', () => get('tenant', '/v1/tenant/vms') as Promise<any[]>,
      (rows) => rows.some((v) => v.name === vmName20), (rows) => `count=${rows.length}`)
    vmId20 = created.find((v) => v.name === vmName20).id

    const row = () => page.getByRole('listitem').filter({ hasText: vmName20 })
    const deleteButton = () => row().getByRole('button', { name: 'Delete', exact: true })
    await expect(row()).toBeVisible()

    let sawNotCreated = false
    let sawExistsWhileCreating = false
    await pollUntil('UI-20 vm running', async () => {
      // A long poll may sign in again (auth.ts headersOf), which closes the old browser context: pick up the
      // current page and reload before reading it, or the row's own token can run out mid-loop.
      const current = await pageOf('tenant')
      if (current !== page) {
        page = current
        await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
      }
      // Read the button state BEFORE the API call it is meant to reflect: existence only moves NotCreated ->
      // Exists, so a disabled reading taken first is still valid against a NotCreated read that follows it
      // (the server cannot have moved backwards in the meantime) — reading after the GET would let the UI
      // observe a flip to Exists that happened in between and fail a true invariant.
      const disabledBefore = await deleteButton().isDisabled()
      const vm = await get('tenant', `/v1/tenant/vms/${vmId20}`)
      if (vm.transition === 'Creating' && vm.currentExistence === 'NotCreated') {
        expect(disabledBefore, 'Delete must be disabled while Creating and NotCreated').toBe(true)
        sawNotCreated = true
      } else if (vm.transition === 'Creating' && vm.currentExistence === 'Exists') {
        // The list page polls at POLL_MS while a row waits (OpenViCloud/titan-cloud-console:portal/src/hooks/pollUntilSettled.ts) — give the UI one full tick
        // past that to catch up before asserting it reflects the already-Exists API state.
        await expect(deleteButton()).toBeEnabled({ timeout: POLL_MS + 5_000 })
        sawExistsWhileCreating = true
      }
      return vm
    }, (vm) => runs(vm), (vm) => `state=${vm.currentState} existence=${vm.currentExistence} transition=${vm.transition}`, undefined, 3_000)

    // Re-fetch the page (a wait may have signed in again and replaced the context) and confirm Delete is
    // enabled once the VM is settled, regardless of whether the Creating ∧ Exists window above was observed
    // — that window is short and not guaranteed to land between two 3s polls.
    page = await pageOf('tenant')
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    await expect(deleteButton()).toBeEnabled()
    await page.screenshot({ path: `${RESULTS}/UI-20-vm-running-delete-enabled.png` })
    log(`UI-20 ${vmName20} sawNotCreated=${sawNotCreated} sawExistsWhileCreating=${sawExistsWhileCreating}`)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// UI-18 (Buy credit amount parsing, Vietnamese) and UI-26 (404 page, both languages). Independent of the group
// above: no network/VM/volume state, so no interference with their English-language assertions.
// ---------------------------------------------------------------------------------------------------------------

test.describe.serial('portal-ui forms: buy credit and not-found page', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-forms-lang')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    const page = await pageOf('tenant')
    // Leave no language picked, matching the convention other language-switching specs follow.
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    await closeSessions()
  })

  // titan-ops features/billing/topup/design.md#topup-portal · titan-ops features/cloud-console/design.md#portal-language
  // OpenViCloud/titan-cloud-console:portal/src/pages/WalletPage.tsx (BuyCreditDialog: parseWholeVnd gates Continue) · OpenViCloud/titan-cloud-console:portal/src/lib/money.ts
  // (parseWholeVnd('500.000') === 500000; parseWholeVnd('5a0') === null) · OpenViCloud/titan-cloud-console:portal/src/lib/sepay.ts (vietQrUrl:
  // query string carries amount=<integer>) · OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (walletBuy.title Nạp tiền, walletBuy.continue Tiếp tục)
  test('UI-18 in Vietnamese: 500.000 produces a QR for amount=500000; 5a0 disables Continue', async () => {
    const page = await pageOf('tenant')
    // Before the language switch, so a skipped case leaves the language as it found it.
    test.skip(!(await topUpEnabledOf(PORTAL)), 'N/A: the portal config.json has no topUpEnabled: true (no Buy credit on this env)')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /account menu for|menu tài khoản của/i }).click()
    await page.getByRole('menuitemradio', { name: 'Tiếng Việt' }).click()

    await page.goto(PORTAL + '/wallet', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Nạp tiền' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Nạp tiền' })).toBeVisible()
    await page.locator('#topup-amount').fill('500.000')
    await expect(dialog.getByRole('button', { name: 'Tiếp tục' })).toBeEnabled()

    // This DOES create a Pending top-up via POST /v1/tenant/topups (the same acceptable residue UI-07 leaves —
    // CLAUDE.md: beta-user's wallet is read, never settled, outside this one on-purpose exception).
    // ADM-08 confirms its OWN topup by paymentRef (admin/admin-portal.spec.ts, test ADM-08), not "whatever
    // is Pending", so this extra one is never picked up by it.
    const qrPromise = page.waitForRequest((req) => req.url().startsWith('https://qr.sepay.vn/img'), { timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Tiếp tục' }).click()
    const qrRequest = await qrPromise
    const qrUrl = new URL(qrRequest.url())
    expect(qrUrl.searchParams.get('amount')).toBe('500000')
    await page.screenshot({ path: `${RESULTS}/UI-18-qr-amount.png` })
    log(`UI-18 QR amount param=${qrUrl.searchParams.get('amount')} (topup left Pending on purpose)`)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Re-open: 5a0 is not a valid amount (parseWholeVnd returns null for a non-digit suffix), so Continue stays
    // disabled and no second top-up is created.
    await page.getByRole('button', { name: 'Nạp tiền' }).click()
    const dialog2 = page.getByRole('dialog')
    await page.locator('#topup-amount').fill('5a0')
    await expect(dialog2.getByRole('button', { name: 'Tiếp tục' })).toBeDisabled()

    let posted = false
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/v1/tenant/topups')) posted = true
    })
    await page.waitForTimeout(500)
    expect(posted, 'no top-up POST while the amount is invalid').toBe(false)
    await page.screenshot({ path: `${RESULTS}/UI-18-invalid-amount.png` })
    log('UI-18 5a0 kept Continue disabled, no second topup created')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: /menu tài khoản của/i }).click()
    await page.getByRole('menuitemradio', { name: 'English' }).click()
  })

  // titan-ops features/cloud-console/design.md#portal-shell · OpenViCloud/titan-cloud-console:portal/src/pages/NotFoundPage.tsx
  // OpenViCloud/titan-cloud-console:portal/src/pages/NotFoundPage.test.tsx ('says the page does not exist and links back to the overview', 'speaks Vietnamese': role=heading 'Page not found'/'Không tìm thấy trang',
  // link 'Back to overview'/'Về trang tổng quan' → '/') · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (routeErrors.notFoundTitle, routeErrors.backHome)
  test('UI-26 an unknown path shows Page not found in English then Vietnamese, with a link back to Overview', async () => {
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
    await page.goto(PORTAL + '/khong-co-trang-nay', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    // The shell still renders around the error page, proving this is an in-portal route and not a server 404.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    const backLink = page.getByRole('link', { name: 'Back to overview' })
    await expect(backLink).toHaveAttribute('href', '/')
    await page.screenshot({ path: `${RESULTS}/UI-26-not-found-en.png` })
    await backLink.click()
    await expect(page).toHaveURL(PORTAL + '/')

    await page.getByRole('button', { name: /account menu for/i }).click()
    await page.getByRole('menuitemradio', { name: 'Tiếng Việt' }).click()
    await page.goto(PORTAL + '/khong-co-trang-nay', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Không tìm thấy trang' })).toBeVisible()
    const backLinkVi = page.getByRole('link', { name: 'Về trang tổng quan' })
    await expect(backLinkVi).toHaveAttribute('href', '/')
    await page.screenshot({ path: `${RESULTS}/UI-26-not-found-vi.png` })
    await backLinkVi.click()
    await expect(page).toHaveURL(PORTAL + '/')
    log('UI-26 not-found page shown in both languages, both links go to /')

    await page.getByRole('button', { name: /menu tài khoản của/i }).click()
    await page.getByRole('menuitemradio', { name: 'English' }).click()
  })
})
