import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { cleanUp } from './clean-up'
import { RESULTS, bodyOf, call, expectStatus, get, log, newKey, startLog } from './api'
import { RUN, envOf, nameOf, waitNetwork } from './fixtures'
import { callWithToken, newSecret } from './token'

// Cases SUS-01..05 of plan.md. beta-user's tenant is Suspended for the length of this module only:
// afterAll puts it back to Active whatever happened.
test.describe.serial('tenant-suspend', () => {
  let tenantId = ''
  let suspended = false
  // SUS-04: an API token made while the tenant is still Active, deleted in afterAll once it is Active again.
  const tokenSecret = newSecret()
  let tokenId = ''
  // SUS-05: the name the portal's refused create carries; afterAll deletes it should a create ever get through.
  const portalNetworkName = `rg-susnet2-${RUN}`
  let portalUsed = false

  async function setStatus(status: string): Promise<void> {
    const reply = await call('admin', 'PATCH', `/v1/tenants/${tenantId}/status`, { status })
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('tenant-suspend')
    useBrowser(browser)
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    expect(tenant.status, 'start from an Active tenant').toBe('Active')
    const created = await call('tenant', 'POST', '/v1/tenant/api-tokens', { name: nameOf('tok-sus'), token: tokenSecret, expiresInDays: 30 }, newKey())
    expectStatus(created, 201)
    tokenId = bodyOf(created).apiTokenId
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = []
    if (suspended) {
      steps.push(['beta-user Active again', async () => {
        await setStatus('Active')
        log('afterAll: beta-user Active again')
      }])
    }
    if (tokenId !== '') {
      steps.push([`delete token ${tokenId}`, async () => {
        const deleted = await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${tokenId}`)
        expect([204, 404], `${deleted.url} → ${deleted.text.slice(0, 200)}`).toContain(deleted.status)
      }])
    }
    steps.push(['SUS-05 network, should one exist', async () => {
      const left = (await get('tenant', '/v1/tenant/networks') as any[]).filter((n) => n.name === portalNetworkName)
      for (const network of left) {
        if (network.desiredExistence === 'Exists') {
          await waitNetwork('cleanup: SUS-05 network at rest', network.id, (n) => n.transition === null)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${network.id}`), 202)
        }
        await waitNetwork('cleanup: SUS-05 network deleted', network.id, (n) => n.currentExistence === 'Deleted')
        log(`afterAll: deleted ${portalNetworkName} (${network.id})`)
      }
    }])
    if (portalUsed) {
      // SUS-05 switches the language; leave none picked.
      steps.push(['language', async () => {
        const page = await pageOf('tenant')
        await page.evaluate(() => localStorage.removeItem('ovc-lang'))
      }])
    }
    steps.push(['close sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantStatusEndpoint.cs (Configure: Patch("v1/tenants/{tenantId:guid}/status");
  // HandleAsync: SendNoContentAsync);
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/TenantResolutionMiddleware.cs InvokeAsync (isWrite ⇒ TENANT_SUSPENDED) (a middleware 403 is {code, message}: titan-ops architecture/http-contract.md, named exceptions) — writes refused, reads pass
  test('SUS-01 a suspended tenant reads but cannot write: 403 TENANT_SUSPENDED', async () => {
    suspended = true
    await setStatus('Suspended')
    const tenant = await get('tenant', '/v1/tenant')
    expect(tenant.status).toBe('Suspended')
    expectStatus(await call('tenant', 'GET', '/v1/tenant/vms'), 200)
    const { clusterId } = await envOf()
    const write = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-susnet-${RUN}`, clusterId, cidr: '10.88.0.0/24' }, newKey())
    log(`SUS-01 write → ${write.status} ${write.text.slice(0, 200)}`)
    expectStatus(write, 403)
    expect(bodyOf(write).code).toBe('TENANT_SUSPENDED')
    const networks = await get('tenant', '/v1/tenant/networks') as any[]
    expect(networks.some((n) => n.name === `rg-susnet-${RUN}`)).toBe(false)
  })

  // titan-ops features/tenant/design.md#tenant-status-repeats
  test('SUS-02 suspending again is 204', async () => {
    await setStatus('Suspended')
    expect((await get('tenant', '/v1/tenant')).status).toBe('Suspended')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/ApiTokenAuthenticationHandler.cs (HandleAuthenticateAsync: the token is the
  // member's `sub`, so TenantResolutionMiddleware applies suspension unchanged); OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/
  // TenantResolutionMiddleware.cs InvokeAsync (isWrite ⇒ TENANT_SUSPENDED) · titan-ops features/public-api/design.md#api-token
  test('SUS-04 an API token of the suspended tenant reads 200 and its write is 403 TENANT_SUSPENDED', async () => {
    const read = await callWithToken(tokenSecret, 'GET', '/v1/tenant')
    expectStatus(read, 200)
    expect(bodyOf(read).status).toBe('Suspended')
    const write = await callWithToken(tokenSecret, 'POST', '/v1/tenant/api-tokens', { name: nameOf('tok-sus2'), token: newSecret(), expiresInDays: 30 }, newKey())
    log(`SUS-04 read → ${read.status}; write → ${write.status} ${write.text.slice(0, 200)}`)
    expectStatus(write, 403)
    expect(bodyOf(write).code).toBe('TENANT_SUSPENDED')
  })

  // titan-ops features/cloud-console/user-stories.md#us-sl-01c · titan-ops features/cloud-console/design.md#portal-gate-order
  // OpenViCloud/titan-cloud-console:portal/src/contexts/TenantContext.tsx (TenantProvider: only PendingApproval is gated, Suspended falls
  // through; tenantError ⇒ accountGate.loadFailed) · OpenViCloud/titan-cloud-console:portal/src/pages/DashboardPage.tsx (DashboardPage:
  // network-count = networks.length) · OpenViCloud/titan-cloud-console:portal/src/components/NetworkCreateModal.tsx (handleSubmit: 403
  // TENANT_SUSPENDED ⇒ networkCreate.suspended as apiError, the dialog stays open) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts,
  // OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts (dashboard.title, pendingApproval.title, accountGate.loadFailed, networks.listLabel,
  // networkCreate) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/TenantResolutionMiddleware.cs InvokeAsync (isWrite ⇒ TENANT_SUSPENDED)
  test('SUS-05 the portal of a suspended tenant shows Overview and Networks as the API reads them; Create Network says the account is suspended', async () => {
    test.setTimeout(5 * 60_000)
    expect((await get('tenant', '/v1/tenant')).status, 'between SUS-01 and SUS-03').toBe('Suspended')
    const { clusterId } = await envOf()
    const networks = await get('tenant', '/v1/tenant/networks') as any[]
    log(`SUS-05 API networks: ${networks.map((n) => n.name).join(', ')}`)
    portalUsed = true
    const page = await pageOf('tenant')
    const views = [
      {
        lang: 'en', overview: 'Overview', list: 'Networks', create: 'Create Network', placeholder: 'e.g. production-net',
        pending: 'Account pending approval', loadFailed: 'Failed to load account',
        suspended: 'Your account is suspended — contact support to create resources',
      },
      {
        lang: 'vi', overview: 'Tổng quan', list: 'Mạng', create: 'Tạo mạng', placeholder: 'ví dụ: production-net',
        pending: 'Tài khoản đang chờ duyệt', loadFailed: 'Không tải được tài khoản',
        suspended: 'Tài khoản đang bị tạm ngưng — liên hệ hỗ trợ để tạo tài nguyên',
      },
    ]
    for (const view of views) {
      await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
      await page.evaluate((lang) => localStorage.setItem('ovc-lang', lang), view.lang)
      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.getByRole('heading', { level: 1, name: view.overview })).toBeVisible()
      await expect(page.getByTestId('network-count')).toHaveText(String(networks.length))
      await expect(page.getByText(view.pending)).toHaveCount(0)
      await expect(page.getByText(view.loadFailed)).toHaveCount(0)
      await page.screenshot({ path: `${RESULTS}/SUS-05-overview-${view.lang}.png` })

      await page.goto(PORTAL + '/networks', { waitUntil: 'networkidle' })
      const list = page.getByRole('list', { name: view.list })
      await expect(list.getByRole('listitem')).toHaveCount(networks.length)
      for (const network of networks) {
        await expect(list.getByText(network.name, { exact: true })).toBeVisible()
      }
      await expect(page.getByText(view.pending)).toHaveCount(0)
      await expect(page.getByText(view.loadFailed)).toHaveCount(0)

      await page.getByRole('button', { name: view.create }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: view.create })).toBeVisible()
      await dialog.getByPlaceholder(view.placeholder).fill(portalNetworkName)
      // The Cluster <select> has a <label> without htmlFor, so no accessible name: it is the dialog's only <select>.
      await dialog.locator('select').selectOption(clusterId)
      const posted = page.waitForResponse((res) => res.request().method() === 'POST'
        && new URL(res.url()).pathname === '/v1/tenant/networks')
      await dialog.getByRole('button', { name: view.create }).click()
      const response = await posted
      const body = await response.json()
      log(`SUS-05 ${view.lang} portal POST /v1/tenant/networks → ${response.status()} ${JSON.stringify(body).slice(0, 200)}`)
      expect(response.status()).toBe(403)
      expect(body.code).toBe('TENANT_SUSPENDED')
      await expect(dialog.getByText(view.suspended, { exact: true })).toBeVisible()
      await expect(dialog).toBeVisible()
      await page.screenshot({ path: `${RESULTS}/SUS-05-create-refused-${view.lang}.png` })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      const after = await get('tenant', '/v1/tenant/networks') as any[]
      expect(after.some((n) => n.name === portalNetworkName), `no ${portalNetworkName} listed`).toBe(false)
    }
  })

  test('SUS-03 Active again is 204 and writes pass', async () => {
    await setStatus('Active')
    suspended = false
    expect((await get('tenant', '/v1/tenant')).status).toBe('Active')
    // A write that changes nothing lasting: a create refused by its validator gets past the tenant gate.
    const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name: '', clusterId: '' }, newKey())
    log(`SUS-03 write → ${reply.status} ${reply.text.slice(0, 200)}`)
    expectStatus(reply, 400)
    expect(bodyOf(reply).code).toBe('VALIDATION_ERROR')
  })
})
