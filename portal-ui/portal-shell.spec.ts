import { test, expect, type Page } from '@playwright/test'
import { ADMIN, PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { RESULTS, log, startLog } from './api'

// Cases UI-09..UI-11 and UI-15 of plan.md: theme, brand, language and the shell of both portals.
// Colours are the token values of OpenViCloud/titan-cloud-console:portal/src/index.css (light in @theme, dark under [data-theme=dark]).
const LIGHT_BACKGROUND = 'rgb(243, 244, 247)'
const DARK_BACKGROUND = 'rgb(13, 14, 18)'

async function background(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor)
}

async function chooseTheme(page: Page, label: 'System' | 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('button', { name: /account menu for/i }).click()
  await page.getByRole('menuitemradio', { name: label }).click()
}

test.describe.serial('portal-ui shell', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    const page = await pageOf('tenant')
    // Leave the account on System so the next run starts from the OS setting.
    await page.evaluate(() => localStorage.removeItem('ovc-theme'))
    // Leave no language picked, so the other specs start from the default (the runner is not in Vietnam).
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    const admin = await pageOf('admin')
    await admin.evaluate(() => localStorage.removeItem('ovc-lang'))
    await closeSessions()
  })

  // OpenViCloud/titan-cloud-console:portal/src/index.css (@theme, prefers-color-scheme block) · OpenViCloud/titan-cloud-console:portal/src/lib/theme.ts
  test('UI-09 the theme follows the OS, and the account-menu choice wins and survives a reload', async () => {
    const page = await pageOf('tenant')
    await page.evaluate(() => localStorage.removeItem('ovc-theme'))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false)
    expect(await background(page)).toBe(LIGHT_BACKGROUND)

    await page.emulateMedia({ colorScheme: 'dark' })
    expect(await background(page)).toBe(DARK_BACKGROUND)
    // Cards animate their colours (transition-colors); a screenshot taken at once shows them half-way.
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => {
      const card = document.querySelector('main .rounded-xl')
      if (card === null) return 'no card'
      return getComputedStyle(card).backgroundColor
    })).not.toBe('rgb(255, 255, 255)')
    await page.screenshot({ path: `${RESULTS}/UI-09-system-dark.png` })

    await chooseTheme(page, 'Light')
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
    expect(await background(page)).toBe(LIGHT_BACKGROUND)
    await page.reload({ waitUntil: 'networkidle' })
    expect(await background(page)).toBe(LIGHT_BACKGROUND)
    await page.screenshot({ path: `${RESULTS}/UI-09-light-after-reload.png` })

    await chooseTheme(page, 'System')
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false)
    expect(await background(page)).toBe(DARK_BACKGROUND)
    log('UI-09 system→dark, Light kept after reload, System back to OS')
  })

  // OpenViCloud/titan-cloud-console:portal/index.html <title> · OpenViCloud/titan-cloud-console:portal/src/components/MainLayout.tsx
  // OpenViCloud/titan-admin-console:portal/admin.html <title> · OpenViCloud/titan-admin-console:portal/src/admin/layout/AdminLayout.tsx
  test('UI-10 both portals carry the OpenViCloud brand', async () => {
    const tenant = await pageOf('tenant')
    await tenant.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await expect(tenant).toHaveTitle('OpenViCloud')
    await expect(tenant.getByRole('banner')).toContainText('OpenViCloud')
    expect(await tenant.content()).not.toContain('Titan Cloud')

    const admin = await pageOf('admin')
    await admin.goto(ADMIN + '/', { waitUntil: 'networkidle' })
    await expect(admin).toHaveTitle('OpenViCloud Admin')
    await expect(admin.getByRole('banner')).toContainText('OpenViCloud')
    await expect(admin.getByRole('banner')).toContainText('Admin')
    await admin.screenshot({ path: `${RESULTS}/UI-10-admin.png` })
    log('UI-10 titles OpenViCloud / OpenViCloud Admin')
  })

  // OpenViCloud/titan-cloud-console:portal/src/components/shell/AppShell.tsx (drawer under 900px)
  test('UI-11 at 375px the menu is a drawer and nothing scrolls sideways', async () => {
    const page = await pageOf('tenant')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(PORTAL + '/vms', { waitUntil: 'networkidle' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
    const sidebar = page.locator('#app-sidebar')
    await expect(sidebar).toHaveAttribute('data-open', 'false')
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(sidebar).toHaveAttribute('data-open', 'true')
    await page.screenshot({ path: `${RESULTS}/UI-11-drawer.png` })
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Networks' }).click()
    await expect(page).toHaveURL(/\/networks$/)
    await expect(sidebar).toHaveAttribute('data-open', 'false')
    await page.setViewportSize({ width: 1400, height: 900 })
    log('UI-11 scrollWidth 375, drawer opens and closes on navigation')
  })

  // OpenViCloud/titan-cloud-console:portal/src/i18n/LanguageProvider.tsx · OpenViCloud/titan-cloud-console:portal/src/i18n/lang.ts
  // OpenViCloud/titan-cloud-console:portal/src/components/shell/AppShell.tsx
  // (titan-ops features/cloud-console/design.md#portal-language)
  test('UI-15 the language starts from the IP country, the account-menu choice wins and survives a reload', async () => {
    const page = await pageOf('tenant')
    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    await page.reload({ waitUntil: 'networkidle' })
    // The same trace the portal reads; without Cloudflare in front (dev) it is not a trace and the portal stays English.
    const country = await page.evaluate(async () => {
      try {
        const response = await fetch('/cdn-cgi/trace')
        const line = (await response.text()).split('\n').find(l => l.startsWith('loc='))
        if (line === undefined) return null
        return line.slice(4).trim()
      } catch {
        return null
      }
    })
    const expected = country === 'VN' ? 'vi' : 'en'
    // English is also the language before the trace answers: wait past the portal's 1.5 s trace timeout.
    await page.waitForTimeout(2_000)
    expect(await page.evaluate(() => document.documentElement.lang)).toBe(expected)
    expect(await page.evaluate(() => localStorage.getItem('ovc-lang'))).toBeNull()
    log(`UI-15 trace loc=${country} ⇒ first visit in ${expected}, guess not saved`)

    await page.getByRole('button', { name: /account menu for|menu tài khoản của/i }).click()
    await page.getByRole('menuitemradio', { name: 'Tiếng Việt' }).click()
    const nav = page.getByRole('navigation', { name: 'Điều hướng chính' })
    await expect(nav.getByRole('link', { name: 'Máy ảo' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Hoá đơn' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('vi')
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: 'Tổng quan' })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('ovc-lang'))).toBe('vi')
    await page.screenshot({ path: `${RESULTS}/UI-15-customer-vi.png` })

    await page.getByRole('button', { name: /menu tài khoản của/i }).click()
    await page.getByRole('menuitemradio', { name: 'English' }).click()
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Virtual Machines' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')

    // The admin portal has the same switch, and remembers the choice across a reload.
    const admin = await pageOf('admin')
    await admin.goto(ADMIN + '/', { waitUntil: 'networkidle' })
    await admin.getByRole('button', { name: /account menu for|menu tài khoản của/i }).click()
    await admin.getByRole('menuitemradio', { name: 'Tiếng Việt' }).click()
    await expect(admin.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: 'Tenant' })).toBeVisible()
    await admin.reload({ waitUntil: 'networkidle' })
    await expect(admin.getByRole('heading', { level: 1 })).toHaveText('Tổng quan')
    expect(await admin.evaluate(() => document.documentElement.lang)).toBe('vi')
    await admin.screenshot({ path: `${RESULTS}/UI-15-admin-vi.png` })
    log('UI-15 vi picked and kept after reload; English back; admin vi kept after reload')
  })
})
