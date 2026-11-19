import { test, expect, type Page, type Route } from '@playwright/test'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { API, RESULTS, bodyOf, call, expectStatus, get, log, newKey, sleep, startLog } from './api'
import { cleanUp } from './clean-up'
import { RUN, envOf, nameOf, runNetwork, runs, waitVm } from './fixtures'

// Cases UI-35..UI-40 of plan.md: the console password, stop timeout and cloud-init user data fields of the Create VM form,
// the Console tab of the VM page, its Stop timeout panel and its Add SSH key dialog. One VM, made through the form by
// UI-35, is the subject of UI-36, UI-38, UI-39 (its user data read back) and UI-40; UI-37 sends no create. UI-36 opens console sessions of the tenant: they count toward its five SSH and console
// sessions, so this file does not run beside a job that counts them (CLAUDE.md, shared data between lanes).

// The words of the form in each language (OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts,
// OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts: vms.create, vmCreate.title, namePlaceholder, cluster, network, template,
// size, consolePassword, stopTimeout, userData, submit, consolePasswordLength, stopTimeoutRange, userDataTooLarge).
type FormWords = {
  lang: 'en' | 'vi'
  open: string
  title: string
  namePlaceholder: string
  cluster: string
  network: string
  template: string
  size: string
  consolePassword: string
  stopTimeout: string
  userData: string
  submit: string
  passwordLength: string
  stopTimeoutRange: string
  userDataTooLarge32770: string
}

const FORM: Record<'en' | 'vi', FormWords> = {
  en: {
    lang: 'en',
    open: 'Create VM',
    title: 'Create Virtual Machine',
    namePlaceholder: 'e.g. web-server-01',
    cluster: 'Cluster',
    network: 'Network',
    template: 'Template',
    size: 'Size',
    consolePassword: 'Console password',
    stopTimeout: 'Stop timeout (seconds)',
    userData: 'Cloud-init user data',
    submit: 'Create VM',
    passwordLength: 'The console password must be 12 to 72 characters.',
    stopTimeoutRange: 'The stop timeout must be a whole number of seconds from 30 to 1800.',
    userDataTooLarge32770: 'Cloud-init user data is 32770 bytes; the limit is 32768.',
  },
  vi: {
    lang: 'vi',
    open: 'Tạo VM',
    title: 'Tạo máy ảo',
    namePlaceholder: 'ví dụ: web-server-01',
    cluster: 'Cluster',
    network: 'Mạng',
    template: 'Template',
    size: 'Cấu hình',
    consolePassword: 'Mật khẩu console',
    stopTimeout: 'Thời gian dừng (giây)',
    userData: 'Cloud-init user data',
    submit: 'Tạo VM',
    passwordLength: 'Mật khẩu console phải từ 12 đến 72 ký tự.',
    stopTimeoutRange: 'Thời gian dừng phải là số giây nguyên, từ 30 đến 1800.',
    userDataTooLarge32770: 'Cloud-init user data dài 32770 byte, vượt giới hạn 32768.',
  },
}

// The choices every form below makes. The template is an Ubuntu one: UI-36 logs in as ubuntu, the user the console
// password is set for (titan-ops features/vm/design.md#console-password), and the first template of the cluster is not
// always Ubuntu (the list is sorted by name, titan-ops features/catalog/design.md#template-customer-read).
type Choices = { clusterId: string, networkId: string, templateId: string, tier: string }

async function choicesOf(): Promise<Choices> {
  const { clusterId, smallTier } = await envOf()
  const network = await runNetwork()
  const templates = await get('tenant', `/v1/templates?clusterId=${clusterId}`) as Array<{ id: string, name: string, os: string }>
  const ubuntu = templates.find((t) => /ubuntu/i.test(t.name) || /ubuntu/i.test(t.os))
  expect(ubuntu, `cluster ${clusterId} lists an Ubuntu template: ${templates.map((t) => t.name).join(', ')}`).toBeDefined()
  log(`form choices cluster=${clusterId} network=${network.id} template=${ubuntu!.id} (${ubuntu!.name}) tier=${smallTier}`)
  return { clusterId, networkId: network.id, templateId: ubuntu!.id, tier: smallTier }
}

async function useLanguage(page: Page, path: string, lang: 'en' | 'vi'): Promise<void> {
  await page.goto(PORTAL + path, { waitUntil: 'networkidle' })
  await page.evaluate((l) => localStorage.setItem('ovc-lang', l), lang)
  await page.reload({ waitUntil: 'networkidle' })
}

// Opens the form on /vms and makes every choice; the console password and stop timeout are left to the case.
async function openFilledForm(page: Page, words: FormWords, name: string, choices: Choices) {
  await useLanguage(page, '/vms', words.lang)
  await page.getByRole('button', { name: words.open, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: words.title })).toBeVisible()
  await dialog.getByPlaceholder(words.namePlaceholder).fill(name)
  await dialog.getByRole('combobox', { name: words.cluster, exact: true }).selectOption(choices.clusterId)
  await dialog.getByRole('combobox', { name: words.network, exact: true }).selectOption(choices.networkId)
  await dialog.getByRole('combobox', { name: words.template, exact: true }).selectOption(choices.templateId)
  await dialog.getByRole('combobox', { name: words.size, exact: true }).selectOption(choices.tier)
  return dialog
}

// Every POST /v1/tenant/vms of the page while held: counted, then aborted, so a form that wrongly sends one makes no VM.
// GET of the same path (the list) goes through.
async function holdCreates(page: Page): Promise<{ posted: string[], release: () => Promise<void> }> {
  const posted: string[] = []
  const isCreate = (url: URL) => url.pathname === '/v1/tenant/vms'
  const handler = async (route: Route) => {
    if (route.request().method() === 'POST') {
      posted.push(route.request().url())
      await route.abort()
      return
    }
    await route.continue()
  }
  await page.route(isCreate, handler)
  return { posted, release: () => page.unroute(isCreate, handler) }
}

function passwordOf(length: number): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(length)
  let password = ''
  for (let i = 0; i < length; i++) {
    password += letters[bytes[i] % letters.length]
  }
  return password
}

// A fresh OpenSSH ed25519 public key: POST /v1/tenant/ssh-keys parses the key, so random bytes would be refused.
// The same construction as contract/contract-spec.spec.ts ed25519PublicKey.
function ed25519PublicKey(comment: string): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const raw = der.subarray(der.length - 32)
  const chunk = (buf: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(buf.length, 0)
    return Buffer.concat([len, buf])
  }
  const blob = Buffer.concat([chunk(Buffer.from('ssh-ed25519')), chunk(raw)])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

// The words of the Add SSH key dialog and of the feed rows it leads to (OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts,
// OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts: vmKeyAddition.addKey, dialogTitle, dialogDescription, submit, adding,
// added, restartNeeded; activityActions.vmAddKeysRequested, vmKeysAdded). The badge shows the API's status, English in both.
const ADD_KEY = {
  en: {
    lang: 'en' as const,
    addKey: 'Add SSH key',
    title: 'Add an SSH key',
    description: 'Pick 1 to 10 saved SSH keys to add to this running VM.',
    submit: 'Add',
    adding: 'Adding the key to the VM…',
    added: 'Key added',
    restartNeeded: 'The key takes effect once you stop the VM and start it again.',
    feedRequested: 'Requested SSH key addition',
    feedAdded: 'Added SSH key',
  },
  vi: {
    lang: 'vi' as const,
    addKey: 'Thêm SSH key',
    title: 'Thêm SSH key',
    description: 'Chọn 1 đến 10 SSH key đã lưu để thêm vào VM đang chạy này.',
    submit: 'Thêm',
    adding: 'Đang thêm key vào VM…',
    added: 'Đã thêm key',
    restartNeeded: 'Key có hiệu lực sau khi bạn Tắt VM rồi Bật lại.',
    feedRequested: 'Yêu cầu thêm SSH key vào VM',
    feedAdded: 'Đã thêm SSH key',
  },
}

// A delete while the create still waits is refused (VM_INVALID_STATUS, titan-ops features/vm/design.md#requests-follow-incus),
// so wait past Creating first.
async function deleteVmAndWait(id: string): Promise<void> {
  const vm = await waitVm(`cleanup: vm ${id} out of Creating`, id, (v) => v.status !== 'Creating')
  if (vm.status === 'Deleted') {
    return
  }
  expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${id}`), 202)
  await waitVm('cleanup: vm deleted', id, (v) => v.status === 'Deleted')
}

// A VM of this run by one of these names that a case did not record (a create the form sent unexpectedly).
async function deleteStrays(names: string[], known: string[]): Promise<void> {
  const rows = await get('tenant', '/v1/tenant/vms') as Array<{ id: string, name: string, status: string }>
  for (const row of rows) {
    if (names.includes(row.name) && !known.includes(row.id) && row.status !== 'Deleted') {
      log(`cleanup: stray ${row.name} ${row.id}`)
      await deleteVmAndWait(row.id)
    }
  }
}

// Whether the cluster's serial console can attach: not on an arm64 Incus (titan-ops features/vm/design.md#vm-console,
// VM_CONSOLE_UNAVAILABLE), but on amd64. No API names the cluster's architecture. On dev the runner pod's node and the
// Incus host are two VMs of one machine of the same architecture (OpenViCloud/titan-local-cluster:docs/topology.md);
// the release environment's cluster is amd64 (plan.md:158, CSL-03). The same rule as vm/vm.spec.ts serialConsoleAttaches.
function serialConsoleAttaches(): boolean {
  const onDev = new URL(API).hostname.endsWith('.localhost')
  return !onDev || process.arch === 'x64'
}

async function until(seen: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (seen()) {
      return true
    }
    await sleep(500)
  }
  return seen()
}

// Up to every 30 s until `seen`, the session closes, or the deadline: `send` once per round, then wait out the round.
async function everyThirtySeconds(send: () => Promise<void>, seen: () => boolean, closed: () => boolean, deadline: number): Promise<boolean> {
  while (Date.now() < deadline && !closed()) {
    const round = Date.now()
    await send()
    const left = Math.min(round + 30_000, deadline) - Date.now()
    if (await until(() => seen() || closed(), Math.max(left, 0))) {
      return seen()
    }
  }
  return seen()
}

// ---------------------------------------------------------------------------------------------------------------
// UI-37: the stop timeout field of the form. No VM: every create the form sends is aborted and counted.
// ---------------------------------------------------------------------------------------------------------------

test.describe.serial('portal-ui vm form: stop timeout', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  const nameSt = nameOf('vmuist')

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-vm-form')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    await cleanUp([
      ['stray vm', () => deleteStrays([nameSt], [])],
      ['language', async () => {
        const page = await pageOf('tenant')
        await page.evaluate(() => localStorage.removeItem('ovc-lang'))
      }],
      ['sessions', closeSessions],
    ])
  })

  // titan-ops features/vm/design.md#vm-stop-timeout · titan-ops features/vm/design.md#vm-portal (VmCreateModal: the field filled
  // with 120; not a whole number of seconds 30–1800 ⇒ the message, nothing sent) ·
  // OpenViCloud/titan-cloud-console:portal/src/components/VmCreateModal.tsx (validate: parseStopTimeout(stopTimeout) === null ⇒
  // vmCreate.stopTimeoutRange, before the four choices) · OpenViCloud/titan-cloud-console:portal/src/lib/vmStopTimeout.ts
  // (STOP_TIMEOUT_DEFAULT 120, parseStopTimeout: /^\d+$/ and 30..1800) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts,
  // OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (vmCreate.stopTimeout, vmCreate.stopTimeoutRange)
  test('UI-37 the Stop timeout field starts at 120; 29 and abc show the 30 to 1800 message and send no create, in English then Vietnamese', async () => {
    const choices = await choicesOf()
    const page = await pageOf('tenant')
    const held = await holdCreates(page)
    try {
      for (const words of [FORM.en, FORM.vi]) {
        const dialog = await openFilledForm(page, words, nameSt, choices)
        const field = dialog.getByLabel(words.stopTimeout, { exact: true })
        await expect(field).toHaveValue('120')
        for (const typed of ['29', 'abc']) {
          await field.fill(typed)
          await dialog.getByRole('button', { name: words.submit, exact: true }).click()
          await expect(dialog.getByText(words.stopTimeoutRange, { exact: true })).toBeVisible()
          await page.waitForTimeout(500) // a wrongly-sent request gets a moment to show before its absence is asserted
          expect(held.posted, `${words.lang} ${typed}: no POST /v1/tenant/vms`).toEqual([])
          await expect(dialog).toBeVisible()
          await page.screenshot({ path: `${RESULTS}/UI-37-${words.lang}-${typed}.png` })
          log(`UI-37 ${words.lang} ${typed}: "${words.stopTimeoutRange}", no POST`)
        }
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      }
    } finally {
      await held.release()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// UI-35, UI-39, UI-38, UI-36, UI-40: one VM made through the form with a console password, a stop timeout of 300 and
// cloud-init user data. UI-39 and UI-38 before UI-36: a console that never shows a prompt must not skip them. UI-40
// after UI-36: by then cloud-init has run its last stage on the VM.
// ---------------------------------------------------------------------------------------------------------------

test.describe.serial('portal-ui vm: console password, stop timeout panel and Console tab', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  let vmId = ''
  let consolePassword = ''
  // What UI-35 pasted into the user data field and what its POST body carried (undefined: no such field), read by UI-39.
  let userDataPasted = ''
  let userDataPosted: unknown = undefined
  const namePw = nameOf('vmuipw')
  const nameUd = nameOf('vmuiud')

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-vm-console')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    await cleanUp([
      ['vm', async () => {
        if (vmId !== '') {
          await deleteVmAndWait(vmId)
        }
      }],
      ['stray vm', () => deleteStrays([namePw, nameUd], vmId === '' ? [] : [vmId])],
      // The cases switch the language; leave none picked, so the next spec starts from the default.
      ['language', async () => {
        const page = await pageOf('tenant')
        await page.evaluate(() => localStorage.removeItem('ovc-lang'))
      }],
      ['sessions', closeSessions],
    ])
  })

  // titan-ops features/vm/design.md#vm-portal (VmCreateModal: Console password type=password, under 12 or over 72 ⇒ the message,
  // nothing sent; Stop timeout equal to 120 is not sent) · titan-ops features/vm/design.md#console-password ·
  // titan-ops features/vm/design.md#vm-stop-timeout · OpenViCloud/titan-cloud-console:portal/src/components/VmCreateModal.tsx
  // (validate: consolePasswordLength before the stop timeout and the choices; handleSubmit: consolePassword when not empty,
  // stopTimeoutSeconds when it differs from STOP_TIMEOUT_DEFAULT) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts,
  // OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (vmCreate.consolePassword, vmCreate.consolePasswordLength)
  test('UI-35 a console password of 11 characters is refused with no create; 16 characters with Stop timeout 300 is sent as typed and the VM runs; the message again in Vietnamese', async () => {
    const choices = await choicesOf()
    const page = await pageOf('tenant')

    const held = await holdCreates(page)
    try {
      const dialog = await openFilledForm(page, FORM.en, namePw, choices)
      const password = dialog.locator('#console-password')
      await expect(dialog.getByLabel(FORM.en.consolePassword, { exact: true })).toHaveAttribute('type', 'password')
      await password.fill(passwordOf(11))
      await dialog.getByRole('button', { name: FORM.en.submit, exact: true }).click()
      await expect(dialog.getByText(FORM.en.passwordLength, { exact: true })).toBeVisible()
      await page.waitForTimeout(500)
      expect(held.posted, '11 characters: no POST /v1/tenant/vms').toEqual([])
      await page.screenshot({ path: `${RESULTS}/UI-35-en-password-11.png` })
      log(`UI-35 en 11 characters: "${FORM.en.passwordLength}", no POST`)
    } finally {
      await held.release()
    }

    // The same open form: 16 characters and a stop timeout of 300, sent for real.
    const dialog = page.getByRole('dialog')
    consolePassword = passwordOf(16)
    await dialog.locator('#console-password').fill(consolePassword)
    await dialog.getByLabel(FORM.en.stopTimeout, { exact: true }).fill('300')
    userDataPasted = `#cloud-config\n# rg-${RUN} ✓ tiếng Việt\n`
    await dialog.getByLabel(FORM.en.userData, { exact: true }).fill(userDataPasted)
    const isCreate = (method: string, url: string) => method === 'POST' && new URL(url).pathname === '/v1/tenant/vms'
    const sent = page.waitForResponse((res) => isCreate(res.request().method(), res.url()))
    await dialog.getByRole('button', { name: FORM.en.submit, exact: true }).click()
    const response = await sent
    expect(response.status(), 'POST /v1/tenant/vms').toBe(202)
    vmId = (await response.json()).vmId as string
    const body = response.request().postDataJSON()
    userDataPosted = body.userData
    expect(body.consolePassword === consolePassword, 'the body carries the console password as typed').toBe(true)
    expect(body.stopTimeoutSeconds).toBe(300)
    expect(body.name).toBe(namePw)
    await expect(dialog).toHaveCount(0)
    log(`UI-35 ${namePw} ${vmId}: POST 202, consolePassword of ${String(body.consolePassword).length} characters as typed, stopTimeoutSeconds ${body.stopTimeoutSeconds}`)

    const vm = await waitVm('UI-35 vm runs', vmId, runs)
    expect(vm.stopTimeoutSeconds).toBe(300)
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    await expect(page.getByRole('listitem').filter({ hasText: namePw })).toContainText(vm.status)
    await page.screenshot({ path: `${RESULTS}/UI-35-vm-runs.png` })

    const heldVi = await holdCreates(page)
    try {
      const dialogVi = await openFilledForm(page, FORM.vi, namePw, choices)
      await expect(dialogVi.getByLabel(FORM.vi.consolePassword, { exact: true })).toHaveAttribute('type', 'password')
      await dialogVi.locator('#console-password').fill(passwordOf(11))
      await dialogVi.getByRole('button', { name: FORM.vi.submit, exact: true }).click()
      await expect(dialogVi.getByText(FORM.vi.passwordLength, { exact: true })).toBeVisible()
      await page.waitForTimeout(500)
      expect(heldVi.posted, 'vi 11 characters: no POST /v1/tenant/vms').toEqual([])
      await page.screenshot({ path: `${RESULTS}/UI-35-vi-password-11.png` })
      log(`UI-35 vi 11 characters: "${FORM.vi.passwordLength}", no POST`)
      await page.keyboard.press('Escape')
    } finally {
      await heldVi.release()
    }
  })

  // titan-ops features/vm/user-stories.md#us-vm-userdata · titan-ops features/vm/design.md#vm-create-flow (user data: at most
  // 32768 bytes of UTF-8) · OpenViCloud/titan-cloud-console:portal/src/components/VmCreateModal.tsx (validate: userDataByteLength over
  // USER_DATA_MAX_BYTES ⇒ vmCreate.userDataTooLarge, after the console password and stop timeout, before the choices; handleSubmit:
  // userData only when not empty; the textarea #vm-user-data with placeholder vmCreate.userDataPlaceholder and vmCreate.userDataHint) ·
  // OpenViCloud/titan-cloud-console:portal/src/lib/vmUserData.ts (USER_DATA_MAX_BYTES 32768, userDataByteLength: TextEncoder bytes) ·
  // OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (vmCreate.userData,
  // userDataPlaceholder, userDataHint, userDataTooLarge) · OpenViCloud/titan-control-plane:Titan.Application/Queries/Compute/Vm/Contracts/VmQueryResult.cs
  // (VmQueryResult: UserData). UI-02's create, which leaves the field empty, is checked in portal-flows.spec.ts under this ID.
  test('UI-39 the Cloud-init user data field hints its 32768-byte limit; 32770 bytes are refused with no create, in English then Vietnamese; UI-35 sent its user data as pasted and the VM reads it back byte for byte', async () => {
    const choices = await choicesOf()
    const page = await pageOf('tenant')
    // 16 385 two-byte characters: 16 385 UTF-16 units, under the limit if the form counted characters, 32 770 bytes of UTF-8.
    const oversize = 'á'.repeat(16_385)
    expect(Buffer.byteLength(oversize, 'utf8')).toBe(32_770)

    const held = await holdCreates(page)
    try {
      for (const words of [FORM.en, FORM.vi]) {
        const dialog = await openFilledForm(page, words, nameUd, choices)
        const field = dialog.getByLabel(words.userData, { exact: true })
        if (words.lang === 'en') {
          await expect(field).toHaveAttribute('placeholder', '#cloud-config')
          await expect(dialog.getByText('Optional. Cloud-init user data, such as #cloud-config, run on first boot. Up to 32768 bytes.', { exact: true })).toBeVisible()
          await page.screenshot({ path: `${RESULTS}/UI-39-en-field.png` })
        }
        await field.fill(oversize)
        await dialog.getByRole('button', { name: words.submit, exact: true }).click()
        await expect(dialog.getByText(words.userDataTooLarge32770, { exact: true })).toBeVisible()
        await page.waitForTimeout(500) // a wrongly-sent request gets a moment to show before its absence is asserted
        expect(held.posted, `${words.lang} 32770 bytes: no POST /v1/tenant/vms`).toEqual([])
        await expect(dialog).toBeVisible()
        await page.screenshot({ path: `${RESULTS}/UI-39-${words.lang}-too-large.png` })
        log(`UI-39 ${words.lang} 32770 bytes: "${words.userDataTooLarge32770}", no POST`)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      }
    } finally {
      await held.release()
    }

    expect(vmId, 'UI-35 made a VM').not.toBe('')
    expect(userDataPosted === userDataPasted, `UI-35's POST body carries userData as pasted (${JSON.stringify(userDataPosted)})`).toBe(true)
    const vm = await get('tenant', `/v1/tenant/vms/${vmId}`)
    expect(typeof vm.userData, 'GET /v1/tenant/vms/{vmId} returns userData').toBe('string')
    const read = Buffer.from(vm.userData as string, 'utf8')
    const pasted = Buffer.from(userDataPasted, 'utf8')
    expect(read.equals(pasted), `userData read back ${read.toString('hex')} against pasted ${pasted.toString('hex')}`).toBe(true)
    log(`UI-39 ${namePw} ${vmId}: POST userData as pasted, GET returns the same ${pasted.length} bytes`)
  })

  // titan-ops features/vm/design.md#vm-page (panel Stop timeout: `<n> s (<m> min)`; Save disabled while the field is unchanged;
  // out of range ⇒ the form's message, no PATCH; save ⇒ PATCH {stopTimeoutSeconds}, "Stop timeout saved") ·
  // titan-ops features/vm/design.md#vm-stop-timeout · OpenViCloud/titan-cloud-console:portal/src/components/vm/VmStopTimeoutPanel.tsx
  // (VmStopTimeoutPanel: changed, handleSave) · OpenViCloud/titan-cloud-console:portal/src/hooks/useVms.ts (useUpdateVm: PATCH
  // /v1/tenant/vms/{vmId} with the body less vmId, then the list is read again) ·
  // OpenViCloud/titan-cloud-console:portal/src/pages/VmDetailPage.tsx (`key` of VmStopTimeoutPanel: the saved value remounts it) ·
  // OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (vmDetail.stopTimeout, stopTimeoutValue, stopTimeoutInput, stopTimeoutRange,
  // stopTimeoutSaved, common.save) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/UpdateVmEndpoint.cs
  // (UpdateVmEndpoint: SendNoContentAsync)
  test('UI-38 the Stop timeout panel shows 300 s (5 min); Save waits for a change; 29 is refused with no PATCH; 600 is saved, shown without a reload and after one', async () => {
    test.skip(vmId === '', 'UI-35 made no VM')
    await waitVm('UI-38 vm runs', vmId, runs)
    const page = await pageOf('tenant')
    await useLanguage(page, `/vms/${vmId}`, 'en')
    const patches: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && new URL(req.url()).pathname === `/v1/tenant/vms/${vmId}`) patches.push(req.url())
    })
    await page.getByRole('tab', { name: 'Overview', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true')
    // A marker a reload would wipe: the saved value must show without one.
    await page.evaluate(() => { (window as any).__rgNoReload = true })
    const panel = page.getByRole('region', { name: 'Stop timeout', exact: true })
    const value = panel.getByTestId('vm-stop-timeout')
    const field = panel.getByLabel('New stop timeout in seconds', { exact: true })
    const save = panel.getByRole('button', { name: 'Save', exact: true })
    await expect(value).toHaveText('300 s (5 min)')
    await expect(field).toHaveValue('300')
    await expect(save).toBeDisabled()
    await page.screenshot({ path: `${RESULTS}/UI-38-panel-300.png` })

    await field.fill('29')
    await expect(save).toBeEnabled()
    await save.click()
    await expect(panel.getByText('The stop timeout must be a whole number of seconds from 30 to 1800.', { exact: true })).toBeVisible()
    await page.waitForTimeout(500)
    expect(patches, '29: no PATCH').toEqual([])
    await expect(value).toHaveText('300 s (5 min)')
    await page.screenshot({ path: `${RESULTS}/UI-38-refused-29.png` })
    log('UI-38 29: the range message, no PATCH')

    await field.fill('600')
    const patched = page.waitForResponse((res) => res.request().method() === 'PATCH'
      && new URL(res.url()).pathname === `/v1/tenant/vms/${vmId}`)
    await save.click()
    const response = await patched
    expect(response.request().postDataJSON()).toEqual({ stopTimeoutSeconds: 600 })
    expect(response.status()).toBe(204)
    expect(patches.length, 'one PATCH for one Save').toBe(1)
    await expect(page.getByText('Stop timeout saved', { exact: true })).toBeVisible()
    await expect(value).toHaveText('600 s (10 min)')
    expect(await page.evaluate(() => (window as any).__rgNoReload === true), 'the page was not reloaded').toBe(true)
    await page.screenshot({ path: `${RESULTS}/UI-38-saved-600.png` })
    expect((await get('tenant', `/v1/tenant/vms/${vmId}`)).stopTimeoutSeconds).toBe(600)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('region', { name: 'Stop timeout', exact: true }).getByTestId('vm-stop-timeout')).toHaveText('600 s (10 min)')
    await page.screenshot({ path: `${RESULTS}/UI-38-after-reload.png` })
    log('UI-38 600: PATCH {stopTimeoutSeconds: 600} 204, toast, 600 s (10 min) before and after a reload')
  })

  // titan-ops features/vm/design.md#console-tab (the panel loads only when the tab opens; not connected: the login sentence and
  // Connect; Disconnect ⇒ "the session ended", Reconnect) · titan-ops features/vm/design.md#vm-console ·
  // titan-ops features/vm/design.md#console-password (the password works once cloud-init's last stage ran) ·
  // OpenViCloud/titan-cloud-console:portal/src/pages/VmDetailPage.tsx (VmConsolePanel through lazy(import())) ·
  // OpenViCloud/titan-cloud-console:portal/src/components/vm/VmConsolePanel.tsx (VmConsolePanel: connect, disconnect; after
  // Disconnect the message is `ended` whatever the close code) · OpenViCloud/titan-cloud-console:portal/src/lib/consoleSession.ts
  // (closeMessage: VM_CONSOLE_UNAVAILABLE ⇒ unavailable) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts,
  // OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (vmDetail.tabConsole, vmConsole.title, loginHint, connect, disconnect,
  // ended, reconnect, unavailable). The terminal is read in the page (xterm's rows); the bytes the console sends are read
  // from the page's websocket frames, which only decide when to type.
  test('UI-36 the Console tab loads its panel only when opened, logs in as ubuntu with the console password, and Disconnect ends the session, in English then Vietnamese', async () => {
    test.skip(vmId === '', 'UI-35 made no VM')
    test.setTimeout(20 * 60_000)
    await waitVm('UI-36 vm runs', vmId, runs)
    const attaches = serialConsoleAttaches()
    log(`UI-36 serial console attaches on this cluster: ${attaches}`)
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))

    const chunks: string[] = []
    page.on('request', (req) => {
      if (/\/VmConsolePanel-[^/]*$/.test(new URL(req.url()).pathname)) chunks.push(new URL(req.url()).pathname)
    })
    // The console's bytes, appended in order; the ticket in the address is never logged.
    let received = ''
    let socketClosed = false
    page.on('websocket', (ws) => {
      if (!new URL(ws.url()).pathname.endsWith(`/v1/tenant/vms/${vmId}/console`)) {
        return
      }
      socketClosed = false
      ws.on('framereceived', (frame) => {
        received += typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
      })
      ws.on('close', () => { socketClosed = true })
    })

    await page.goto(PORTAL + `/vms/${vmId}`, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: namePw })).toBeVisible()
    expect(chunks, 'no request for the VmConsolePanel chunk before the tab opens').toEqual([])

    await page.getByRole('tab', { name: 'Console', exact: true }).click()
    await expect.poll(() => chunks.length, { message: 'opening the tab asks for the VmConsolePanel chunk' }).toBeGreaterThan(0)
    log(`UI-36 chunk on opening the tab: ${chunks.join(', ')}`)
    let panel = page.getByRole('region', { name: 'Serial console', exact: true })
    await expect(panel.getByText('Log in as ubuntu with the console password set when the VM was created. A VM created without a console password does not accept a password login here.', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-36-en-not-connected.png` })

    await panel.getByRole('button', { name: 'Connect', exact: true }).click()
    if (!attaches) {
      await expect(panel.getByRole('status')).toHaveText('The console of this VM is not available right now.', { timeout: 30_000 })
      await expect(panel.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
      await page.screenshot({ path: `${RESULTS}/UI-36-en-unavailable.png` })
      log('UI-36 en arm64: unavailable, login skipped')
    } else {
      await expect(panel.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible({ timeout: 30_000 })
      const terminal = panel.locator('.xterm-rows')
      await panel.locator('.xterm-screen').click() // xterm's screen layer takes the pointer above .xterm-rows
      const started = Date.now()
      const deadline = started + 10 * 60_000
      const sawLogin = await everyThirtySeconds(async () => { await page.keyboard.press('Enter') },
        () => received.includes('login:'), () => socketClosed, deadline)
      log(`UI-36 login: ${sawLogin} after ${Math.round((Date.now() - started) / 1000)} s; socket closed ${socketClosed}`)
      expect(socketClosed, 'the session is still open').toBe(false)
      expect(sawLogin, 'login: within 10 minutes').toBe(true)
      await expect(terminal).toContainText('login:')
      await page.screenshot({ path: `${RESULTS}/UI-36-en-login.png` })

      let mark = 0
      const loggedIn = await everyThirtySeconds(async () => {
        mark = received.length
        await page.keyboard.type('ubuntu')
        await page.keyboard.press('Enter')
        // The password is typed only at its prompt: typed anywhere else the terminal would echo it.
        if (await until(() => received.slice(mark).includes('assword:'), 15_000)) {
          await page.keyboard.type(consolePassword)
          await page.keyboard.press('Enter')
        }
      }, () => received.slice(mark).includes('ubuntu@'), () => socketClosed, deadline)
      log(`UI-36 prompt ubuntu@: ${loggedIn} after ${Math.round((Date.now() - started) / 1000)} s; socket closed ${socketClosed}`)
      expect(socketClosed, 'the session is still open').toBe(false)
      expect(loggedIn, 'the ubuntu@ prompt within 10 minutes').toBe(true)
      await expect(terminal).toContainText('ubuntu@')
      await page.screenshot({ path: `${RESULTS}/UI-36-en-prompt.png` })

      await panel.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await expect(panel.getByRole('status')).toHaveText('The session ended.')
      await expect(panel.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
      await page.screenshot({ path: `${RESULTS}/UI-36-en-ended.png` })
      log('UI-36 en: Disconnect ⇒ The session ended., Reconnect')
    }

    await useLanguage(page, `/vms/${vmId}`, 'vi')
    await page.getByRole('tab', { name: 'Console', exact: true }).click()
    panel = page.getByRole('region', { name: 'Console serial', exact: true })
    await expect(panel.getByText('Đăng nhập bằng user ubuntu và mật khẩu console đặt lúc tạo VM. VM tạo không có mật khẩu console thì không đăng nhập bằng mật khẩu ở đây được.', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Kết nối', exact: true })).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-36-vi-not-connected.png` })
    if (attaches) {
      // Whether Incus lets the console go within a few seconds of a close is not measured (CSL-04): a busy console would
      // close 4422 VM_CONSOLE_BUSY, so the second session waits a little longer.
      await sleep(10_000)
    }
    await panel.getByRole('button', { name: 'Kết nối', exact: true }).click()
    if (!attaches) {
      await expect(panel.getByRole('status')).toHaveText('Console của VM này hiện không dùng được.', { timeout: 30_000 })
      await expect(panel.getByRole('button', { name: 'Kết nối lại', exact: true })).toBeVisible()
      await page.screenshot({ path: `${RESULTS}/UI-36-vi-unavailable.png` })
      log('UI-36 vi arm64: unavailable')
    } else {
      await expect(panel.getByRole('button', { name: 'Ngắt kết nối', exact: true })).toBeVisible({ timeout: 30_000 })
      // The session relays bytes before it is ended: Enter at the shell answers with a prompt.
      const mark = received.length
      await panel.locator('.xterm-screen').click()
      await page.keyboard.press('Enter')
      expect(await until(() => received.length > mark || socketClosed, 30_000) && !socketClosed, 'the second session answers').toBe(true)
      await panel.getByRole('button', { name: 'Ngắt kết nối', exact: true }).click()
      await expect(panel.getByRole('status')).toHaveText('Phiên đã kết thúc.')
      await expect(panel.getByRole('button', { name: 'Kết nối lại', exact: true })).toBeVisible()
      await page.screenshot({ path: `${RESULTS}/UI-36-vi-ended.png` })
      log('UI-36 vi: Ngắt kết nối ⇒ Phiên đã kết thúc., Kết nối lại')
    }
    // Leaving the tab unmounts the panel, which closes any session still open.
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
  })

  // titan-ops features/vm/user-stories.md#us-vm-add-key · titan-ops features/vm/design.md#vm-key-addition (only a Running VM; the
  // addition is Adding, then Added or Failed; restartNeeded false for a VM made since vendor-data writes the sshd config) ·
  // OpenViCloud/titan-cloud-console:portal/src/components/vm/AddSshKeyDialog.tsx (AddSshKeyAction: the button disabled unless
  // canAddVmKeys; one checkbox #add-ssh-key-<id> per saved key, labelled with its name and fingerprint; Add disabled with none
  // picked; after the POST the dialog follows the addition: a badge with its status, vmKeyAddition.adding while Adding,
  // vmKeyAddition.added and, only when restartNeeded, vmKeyAddition.restartNeeded) · OpenViCloud/titan-cloud-console:portal/src/lib/vmState.ts
  // (canAddVmKeys: status === 'Running') · OpenViCloud/titan-cloud-console:portal/src/hooks/useVmKeyAdditions.ts (useCreateKeyAddition:
  // POST /v1/tenant/vms/{vmId}/key-additions {sshKeyIds}) · OpenViCloud/titan-cloud-console:portal/src/pages/VmDetailPage.tsx
  // (AddSshKeyAction in the header) · OpenViCloud/titan-cloud-console:portal/src/pages/DashboardPage.tsx (RecentActivity) ·
  // OpenViCloud/titan-cloud-console:portal/src/hooks/useActivity.ts (ACTION_KEYS: vm.add_keys_requested, vm.keys_added) ·
  // OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (vmKeyAddition,
  // activityActions.vmAddKeysRequested, activityActions.vmKeysAdded). Vietnamese adds the same key a second time: "Key added"
  // shows only after an addition of the open dialog, and a second addition of a key is a fair one (SSH-10).
  test('UI-40 Add SSH key: the dialog lists the saved keys, Add sends {sshKeyIds} and follows the addition from Adding to Added, the Dashboard feed shows the request and the outcome, in English then Vietnamese; a Stopped VM disables the button', async () => {
    test.skip(vmId === '', 'UI-35 made no VM')
    test.setTimeout(15 * 60_000)
    const vm = await waitVm('UI-40 vm runs', vmId, runs)
    test.skip(vm.status === 'Ready', 'N/A: the VM is Ready, not Running, and a key addition takes only Running (canAddVmKeys)')

    const keyName = nameOf('keyui')
    const created = await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name: keyName, publicKey: ed25519PublicKey(keyName) }, newKey())
    expectStatus(created, 201)
    const keyId = bodyOf(created).id as string
    try {
      const keys = await get('tenant', '/v1/tenant/ssh-keys') as Array<{ id: string, name: string, fingerprint: string }>
      expect(keys.some((k) => k.id === keyId), `${keyName} is listed`).toBe(true)
      log(`UI-40 key ${keyName} ${keyId}; ${keys.length} saved key(s)`)

      const page = await pageOf('tenant')
      for (const words of [ADD_KEY.en, ADD_KEY.vi]) {
        await useLanguage(page, `/vms/${vmId}`, words.lang)
        await expect(page.getByRole('heading', { name: namePw, exact: true })).toBeVisible()
        const open = page.getByRole('button', { name: words.addKey, exact: true })
        await expect(open).toBeEnabled()
        await open.click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('heading', { name: words.title, exact: true })).toBeVisible()
        await expect(dialog.getByText(words.description, { exact: true })).toBeVisible()
        for (const key of keys) {
          await expect(dialog.locator(`#add-ssh-key-${key.id}`)).toHaveAttribute('type', 'checkbox')
          const label = dialog.locator(`label[for="add-ssh-key-${key.id}"]`)
          await expect(label).toContainText(key.name)
          await expect(label).toContainText(key.fingerprint)
        }
        const submit = dialog.getByRole('button', { name: words.submit, exact: true })
        await expect(submit).toBeDisabled()
        await page.screenshot({ path: `${RESULTS}/UI-40-${words.lang}-dialog.png` })

        await dialog.locator(`#add-ssh-key-${keyId}`).check()
        await expect(submit).toBeEnabled()
        const sent = page.waitForResponse((res) => res.request().method() === 'POST'
          && new URL(res.url()).pathname === `/v1/tenant/vms/${vmId}/key-additions`)
        await submit.click()
        const response = await sent
        expect(response.request().postDataJSON()).toEqual({ sshKeyIds: [keyId] })
        expect(response.status(), 'POST /v1/tenant/vms/{vmId}/key-additions').toBe(202)
        const additionId = (await response.json()).keyAdditionId as string

        // The badge holds the status alone; "Adding the key to the VM…" beside it does not match the anchored pattern.
        const badge = dialog.getByText(/^(Adding|Added|Failed)$/)
        await expect(badge).toBeVisible()
        const first = await badge.textContent()
        if (first === 'Adding') {
          await expect(dialog.getByText(words.adding, { exact: true })).toBeVisible()
          await page.screenshot({ path: `${RESULTS}/UI-40-${words.lang}-adding.png` })
        } else {
          // The worker can finish before the dialog's first read of the addition.
          log(`UI-40 ${words.lang}: the dialog's first read was already ${first}; Adding was not on screen`)
        }
        await expect(badge).toHaveText(/^(Added|Failed)$/, { timeout: 5 * 60_000 })
        if ((await badge.textContent()) !== 'Added') {
          const addition = await get('tenant', `/v1/tenant/vms/${vmId}/key-additions/${additionId}`)
          throw new Error(`UI-40 ${words.lang}: addition ${additionId} ended ${addition.status}: ${addition.requestFailureReason}`)
        }
        await expect(dialog.getByText(words.added, { exact: true })).toBeVisible()
        await expect(dialog.getByText(words.restartNeeded, { exact: true })).toHaveCount(0)
        await page.screenshot({ path: `${RESULTS}/UI-40-${words.lang}-added.png` })
        log(`UI-40 ${words.lang} addition ${additionId}: POST {sshKeyIds: [${keyId}]} 202, badge ${first} then Added, "${words.added}", no restart sentence`)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)

        await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
        const feed = page.locator('main').getByRole('listitem').filter({ hasText: namePw })
        await expect(feed.filter({ has: page.getByText(words.feedRequested, { exact: true }) }).first()).toBeVisible()
        await expect(feed.filter({ has: page.getByText(words.feedAdded, { exact: true }) }).first()).toBeVisible()
        await page.screenshot({ path: `${RESULTS}/UI-40-${words.lang}-dashboard.png` })
        log(`UI-40 ${words.lang} feed: "${words.feedRequested}", "${words.feedAdded}" for ${namePw}`)
      }

      const vms = await get('tenant', '/v1/tenant/vms') as Array<{ id: string, name: string, status: string }>
      const stopped = vms.find((v) => v.name.startsWith('rg-') && v.status === 'Stopped')
      if (stopped === undefined) {
        log('UI-40 Stopped VM: no rg-* VM is Stopped; the disabled button of a Stopped VM is not measured')
        test.info().annotations.push({ type: 'not measured', description: 'no rg-* VM is Stopped: the Add SSH key button of a Stopped VM' })
      } else {
        // pageOf() again after a wait on the API: a sign-in closes the old context (auth.ts headersOf).
        const pageStopped = await pageOf('tenant')
        await useLanguage(pageStopped, `/vms/${stopped.id}`, 'en')
        await expect(pageStopped.getByRole('heading', { name: stopped.name, exact: true })).toBeVisible()
        await expect(pageStopped.getByRole('button', { name: ADD_KEY.en.addKey, exact: true })).toBeDisabled()
        await pageStopped.screenshot({ path: `${RESULTS}/UI-40-stopped-disabled.png` })
        log(`UI-40 Stopped VM ${stopped.name} ${stopped.id}: Add SSH key disabled`)
      }
    } finally {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${keyId}`), 204)
      log(`UI-40 key ${keyId} deleted`)
    }
  })
})
