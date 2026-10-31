import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, get, log, startLog } from './api'
import { topUpEnabledOf } from './portal-config'

// Case UI-28 of plan.md: the Wallet page of an environment without top-up. Reads only.
test.describe.serial('portal-ui wallet without top-up', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('portal-wallet-no-topup')
    useBrowser(browser)
    const page = await pageOf('tenant')
    // English formatting regardless of the runner's IP (titan-ops features/cloud-console/design.md#portal-language).
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
  })

  test.afterAll(async () => {
    const page = await pageOf('tenant')
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    await closeSessions()
  })

  function moneyEn(amount: number): string {
    return `${Math.round(amount).toLocaleString('en-US')} ₫`
  }

  // titan-ops features/billing/topup/design.md#topup-portal ·
  // OpenViCloud/titan-cloud-console:portal/src/pages/WalletPage.tsx (WalletPage: Buy credit button, ReceiptsSection and BuyCreditDialog only
  // when topUpEnabled; StatementSection: statementEmptyHint only when topUpEnabled) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (wallet)
  test('UI-28 without topUpEnabled the Wallet shows balance, Outstanding and the statement, and no Buy credit or Receipts', async () => {
    test.skip(await topUpEnabledOf(PORTAL), 'N/A: the portal config.json sets topUpEnabled: true')
    const wallet = await get('tenant', '/v1/tenant/wallet')
    const statement = await get('tenant', '/v1/tenant/wallet/statement')
    log(`UI-28 balance=${wallet.balance} statementLines=${statement.lines.length}`)

    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/wallet', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible()
    const balanceCard = page.getByText('Wallet balance', { exact: true }).locator('xpath=ancestor::div[2]')
    await expect(balanceCard).toContainText(moneyEn(wallet.balance))
    await expect(page.getByText('Outstanding', { exact: true })).toBeVisible()
    await page.screenshot({ path: `${RESULTS}/UI-28-wallet.png` })

    await expect(page.getByRole('button', { name: 'Buy credit' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Receipts' })).toHaveCount(0)
    if (statement.lines.length === 0) {
      log('UI-28 measured: statement empty')
      await expect(page.getByText('No wallet activity yet')).toBeVisible()
      await expect(page.getByText('Buy credit to get started')).toHaveCount(0)
    } else {
      log('UI-28 measured: statement with lines')
      const statementSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Statement' }) })
      await expect(statementSection.getByRole('row')).toHaveCount(statement.lines.length + 1) // +1 header row
    }
  })
})
