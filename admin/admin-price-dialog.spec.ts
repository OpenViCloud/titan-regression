import { test, expect, type Page, type Request } from '@playwright/test'
import { ADMIN, closeSessions, pageOf, useBrowser } from './auth'
import { call, expectStatus, get, log, RESULTS, startLog } from './api'
import { cleanUp } from './clean-up'

// Case ADM-20 of plan.md: the admin portal's Edit price dialog on /catalog refuses a price that is not a whole number of
// đồng and previews the monthly price, and is closed without saving. It changes no price, so unlike ADM-06 it may run on
// prd after the first real customer (titan-ops status/known-state.md#first-real-customer) — the module that holds it may
// not, while admin.spec.ts holds ADM-06. The language starts as English through ovc-lang (as admin-portal.spec.ts does, so
// the runner's IP does not pick it), and is then switched in the account menu.

const TIER = 'm'

// The VM tier price route the dialog saves through (OpenViCloud/titan-admin-console:portal/src/admin/hooks/useAdminCatalog.ts,
// useUpdateVmOfferingPrice).
function isPriceSave(request: Request): boolean {
  return request.method() === 'PATCH' && request.url().includes('/v1/admin/vm-offerings/')
}

async function pickLanguage(page: Page, menuLabel: RegExp, language: string): Promise<void> {
  await page.getByRole('button', { name: menuLabel }).click()
  await page.getByRole('menuitemradio', { name: language }).click()
}

test.describe.serial('admin-price-dialog', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  test.beforeAll(async ({ browser }) => {
    startLog('admin-price-dialog')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await cleanUp([
      ['forget the language pick', async () => {
        const page = await pageOf('admin')
        await page.goto(ADMIN + '/', { waitUntil: 'networkidle' })
        await page.evaluate(() => localStorage.removeItem('ovc-lang'))
      }],
      ['close sessions', closeSessions],
    ])
  })

  // titan-ops features/catalog/design.md#whole-vnd-prices · titan-ops features/catalog/design.md#admin-price-edit ·
  // OpenViCloud/titan-admin-console:portal/src/admin/pages/OfferingsSection.tsx (EditPriceDialog: isValid = parseRate, > 0 and
  // Number.isInteger; Save disabled while not valid; preview f.rate(parsed) and f.money(parsed * HOURS_PER_MONTH), HOURS_PER_MONTH = 730) ·
  // OpenViCloud/titan-admin-console:portal/src/lib/money.ts (parseRate: the decimal mark of the language; formatMoney: en-US grouping) ·
  // OpenViCloud/titan-admin-console:portal/src/i18n/en.ts (adminOfferings: editPriceFor, priceInvalid, preview, savePrice; common.cancel) ·
  // OpenViCloud/titan-admin-console:portal/src/i18n/vi.ts (adminOfferings: editPriceFor, priceInvalid, savePrice; common.cancel; shell.accountMenuFor) ·
  // OpenViCloud/titan-admin-console:portal/src/components/shell/AppShell.tsx (AppShell: the account menu's language items, menuitemradio) ·
  // OpenViCloud/titan-admin-console:portal/src/admin/pages/OfferingsSection.test.tsx ("refuses to submit price 170.5", "refuses a price typed with
  // the Vietnamese decimal mark and reads Vietnamese grouping") · titan-ops architecture/tenancy-and-admin.md#admin-audit ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmOffering/UpdateVmOfferingPriceCommandHandler.cs (PriceChangeAction)
  test('ADM-20 the Edit price dialog refuses 170.5 and 170,5, previews 1000 as 730,000 ₫/month, and closes without saving', async () => {
    const offeringsBefore = await get('anonymous', '/v1/vm-offerings') as any[]
    const tier = offeringsBefore.find((o) => o.id === TIER)
    expect(tier, `tier ${TIER} in GET /v1/vm-offerings`).toBeTruthy()
    const originalPrice = tier.pricePerHour as number
    const auditBefore = new Set((await get('admin', '/v1/admin/audit-log?limit=50') as any[]).map((r) => r.id))
    log(`ADM-20 tier ${TIER} name=${tier.name} price=${originalPrice}`)

    const page = await pageOf('admin')
    const saves: string[] = []
    const onRequest = (request: Request) => {
      if (isPriceSave(request)) {
        saves.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`)
      }
    }
    page.on('request', onRequest)
    try {
      await page.goto(ADMIN + '/', { waitUntil: 'networkidle' })
      await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
      await page.goto(ADMIN + '/catalog', { waitUntil: 'networkidle' })
      const row = page.getByTestId(`vm-offering-${TIER}`)
      const dialog = page.getByRole('dialog')
      const input = dialog.locator('#price-per-hour')
      const help = dialog.locator('#price-help')

      // English: '.' is the decimal mark, so 170.5 reads as a fraction and is refused.
      await row.getByRole('button', { name: `Edit price for ${tier.name}` }).click()
      await expect(dialog).toBeVisible()
      await input.fill('170.5')
      await expect(help).toHaveText('Enter a whole number of đồng greater than 0.')
      await expect(dialog.getByRole('button', { name: 'Save price' })).toBeDisabled()
      await page.screenshot({ path: `${RESULTS}/ADM-20-en-fraction-refused.png` })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toBeHidden()

      // Vietnamese: ',' is the decimal mark, so 170,5 is the same fraction.
      await pickLanguage(page, /^Account menu for /, 'Tiếng Việt')
      await row.getByRole('button', { name: `Sửa giá của ${tier.name}` }).click()
      await expect(dialog).toBeVisible()
      await input.fill('170,5')
      await expect(help).toHaveText('Nhập số đồng nguyên lớn hơn 0.')
      await expect(dialog.getByRole('button', { name: 'Lưu giá' })).toBeDisabled()
      await page.screenshot({ path: `${RESULTS}/ADM-20-vi-fraction-refused.png` })
      await dialog.getByRole('button', { name: 'Huỷ', exact: true }).click()
      await expect(dialog).toBeHidden()

      // English again: 1000 is whole, so Save opens and the preview quotes 730 hours; the dialog is closed, not saved.
      await pickLanguage(page, /^Menu tài khoản của /, 'English')
      await row.getByRole('button', { name: `Edit price for ${tier.name}` }).click()
      await expect(dialog).toBeVisible()
      await input.fill('1000')
      await expect(help).toContainText('≈ 730,000 ₫/month')
      log(`ADM-20 preview of 1000: ${await help.innerText()}`)
      await expect(dialog.getByRole('button', { name: 'Save price' })).toBeEnabled()
      await page.screenshot({ path: `${RESULTS}/ADM-20-en-1000-preview.png` })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toBeHidden()

      log(`ADM-20 price saves the page sent: ${saves.length === 0 ? 'none' : saves.join(' | ')}`)
      expect(saves).toEqual([])
      expect(await get('anonymous', '/v1/vm-offerings')).toEqual(offeringsBefore)
      const added = (await get('admin', '/v1/admin/audit-log?limit=50') as any[])
        .filter((r) => !auditBefore.has(r.id) && r.action === 'pricing.vm_offering.change')
      expect(added).toEqual([])
    } finally {
      page.off('request', onRequest)
      // The price is every tenant's: a save that slipped through (a stray Enter) is put back before anything else runs.
      await cleanUp([
        ['put the price back', async () => {
          const now = (await get('anonymous', '/v1/vm-offerings') as any[]).find((o) => o.id === TIER)
          if (now !== undefined && now.pricePerHour !== originalPrice) {
            log(`ADM-20 price of ${TIER} is ${now.pricePerHour}, putting back ${originalPrice}`)
            expectStatus(await call('admin', 'PATCH', `/v1/admin/vm-offerings/${TIER}/price`, { pricePerHour: originalPrice }), 204)
          }
        }],
      ])
    }
  })
})
