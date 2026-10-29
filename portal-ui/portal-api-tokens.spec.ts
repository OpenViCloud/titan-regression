import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, call, expectStatus, get, log, startLog } from './api'
import { nameOf } from './fixtures'
import { callWithToken } from './token'

// Case UI-27 of plan.md: the API tokens page. The secret is on screen only between Create and Done, so screenshots
// are taken after Done; the secret is read from the page into this process for the clipboard and 401 checks and is
// never logged. afterAll deletes the token through the API if the case stopped before its own delete.
test.describe.serial('portal-ui api tokens', () => {
  const tokenName = nameOf('tok-ui')

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-api-tokens')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(5 * 60_000)
    const left = (await get('tenant', '/v1/tenant/api-tokens') as any[]).filter((t) => t.name === tokenName)
    for (const token of left) {
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${token.id}`), 204)
      log(`afterAll: deleted leftover token ${token.id}`)
    }
    await closeSessions()
  })

  // OpenViCloud/titan-cloud-console:portal/src/pages/ApiTokensPage.tsx (CreateApiTokenDialog: secret shown once with showOnce, Copy writes it
  // to the clipboard, close() forgets it; ApiTokensPage: row name, `prefix…`, expiryText; DeleteConfirmDialog);
  // OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (apiTokens) · titan-ops features/public-api/design.md#api-token
  // · titan-ops features/cloud-console/design.md#portal-language
  test('UI-27 create a 30-day token, copy it, Done hides it, the row shows name, prefix and expiry; delete removes it and the secret is 401', async () => {
    test.setTimeout(5 * 60_000)
    const page = await pageOf('tenant')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(PORTAL).origin })
    await page.goto(PORTAL + '/api-tokens', { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'API tokens' })).toBeVisible()

    await page.getByRole('button', { name: 'Create token' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('#api-token-name').fill(tokenName)
    await dialog.locator('#api-token-lifetime').selectOption('30')
    await dialog.getByRole('button', { name: 'Create token' }).click()

    await expect(dialog.getByRole('heading', { name: 'Copy your token' })).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByText("You won't be able to see this token again. Copy it now.")).toBeVisible()
    const secret = await dialog.getByRole('textbox', { name: 'API token' }).inputValue()
    expect(secret.startsWith('ovc_'), 'the secret starts with ovc_').toBe(true)
    expect(secret.length).toBe(47)
    await dialog.getByRole('button', { name: 'Copy' }).click()
    await expect(page.getByText('Token copied')).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied === secret, 'the clipboard holds exactly the secret shown').toBe(true)
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).toBeHidden()

    expect((await page.content()).includes(secret), 'the secret is gone from the page after Done').toBe(false)
    const api = (await get('tenant', '/v1/tenant/api-tokens') as any[]).find((t) => t.name === tokenName)
    expect(api, 'the API lists the token').toBeTruthy()
    const row = page.getByRole('row').filter({ hasText: tokenName })
    await expect(row).toContainText(`${secret.slice(0, 8)}…`)
    await expect(row).not.toContainText('Never')
    await expect(row).toContainText(String(new Date(api.expiresAt).getUTCFullYear()))
    expect(Date.parse(api.expiresAt) - Date.parse(api.createdAt)).toBe(30 * 24 * 3600_000)
    expectStatus(await callWithToken(secret, 'GET', '/v1/tenant'), 200)
    await page.screenshot({ path: `${RESULTS}/UI-27-token-row.png` })

    await row.getByRole('button', { name: `Delete API token ${tokenName}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByText('API token deleted')).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: tokenName })).toHaveCount(0)
    await page.screenshot({ path: `${RESULTS}/UI-27-token-deleted.png` })
    const after = await callWithToken(secret, 'GET', '/v1/tenant')
    log(`UI-27 ${tokenName} id=${api.id} prefix shown, deleted; secret afterwards → ${after.status}`)
    expectStatus(after, 401)
  })
})
