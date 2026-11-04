import { test, expect } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { API, RESULTS, get, log, startLog } from './api'

// Case UI-32 of plan.md: Log out from the account menu, then open the portal again in the same browser context.
// Last in the module on purpose: the runner runs one worker and takes the files in name order (hence the `z`).
// The context is the one auth.ts signs this file in with — no other spec file shares it (each closes its sessions
// in afterAll) — so the sign-out ends only this context's Keycloak session; the token it held is never used again
// (closeSessions drops it).
test.describe.serial('portal-ui sign-out', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-sign-out')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  // titan-ops features/cloud-console/user-stories.md#us-p02 · titan-ops features/cloud-console/design.md#portal-auth-flow
  // OpenViCloud/titan-cloud-console:portal/src/components/MainLayout.tsx (LogoutItem: signoutRedirect; MainLayout: accountLabel = tenantName)
  // · OpenViCloud/titan-cloud-console:portal/src/components/shell/AppShell.tsx (aria-label shell.accountMenuFor)
  // · OpenViCloud/titan-cloud-console:portal/src/lib/auth.ts (createOidcConfig: post_logout_redirect_uri = the portal origin, oidc-client-ts
  // keeps the user in sessionStorage as oidc.user:…) · OpenViCloud/titan-cloud-console:portal/src/contexts/TenantContext.tsx (TenantProvider:
  // not authenticated ⇒ signinRedirect before any GET /v1/tenant) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts (shell.logOut)
  test('UI-32 Log out lands on the Keycloak sign-in form with no oidc.user left; opening / again stays there, no GET /v1/tenant', async () => {
    const tenant = await get('tenant', '/v1/tenant')
    const page = await pageOf('tenant')
    const portalOrigin = new URL(PORTAL).origin
    // Every document the portal origin loads reports its oidc.user keys at start, before the app runs: the load that
    // follows the sign-out and the later visit to / must find none.
    const oidcUserKeysAtLoad: string[][] = []
    await page.exposeFunction('__rgReportOidcUserKeys', (keys: string[]) => { oidcUserKeysAtLoad.push(keys) })
    await page.addInitScript((origin) => {
      // The top document only: oidc-client-ts renews in an iframe of the same origin.
      if (window.location.origin !== origin || window !== window.top) {
        return
      }
      const keys: string[] = []
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)
        if (key !== null && key.startsWith('oidc.user:')) {
          keys.push(key)
        }
      }
      ;(window as any).__rgReportOidcUserKeys(keys)
    }, portalOrigin)

    await page.goto(PORTAL + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
    await page.reload({ waitUntil: 'networkidle' })
    expect(await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('oidc.user:'))),
      'signed in: the session holds an oidc.user key').toBe(true)
    oidcUserKeysAtLoad.length = 0

    const tenantReads: string[] = []
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (req.method() === 'GET' && url.origin === new URL(API).origin && url.pathname === '/v1/tenant') {
        tenantReads.push(req.url())
      }
    })
    await page.getByRole('button', { name: `Account menu for ${tenant.name}` }).click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()

    const username = page.locator('#username')
    await username.waitFor({ state: 'visible', timeout: 45_000 })
    await expect(page.locator('#password')).toBeVisible()
    expect(new URL(page.url()).origin, 'the sign-in form is Keycloak’s, not the portal').not.toBe(portalOrigin)
    expect(oidcUserKeysAtLoad.length, 'the sign-out came back through the portal origin').toBeGreaterThan(0)
    expect(oidcUserKeysAtLoad.flat(), 'no oidc.user key after Log out').toEqual([])
    await page.screenshot({ path: `${RESULTS}/UI-32-after-log-out.png` })
    log(`UI-32 Log out → ${new URL(page.url()).origin} sign-in form; portal loads seen: ${oidcUserKeysAtLoad.length}`)

    oidcUserKeysAtLoad.length = 0
    await page.goto(PORTAL + '/', { waitUntil: 'domcontentloaded' })
    await username.waitFor({ state: 'visible', timeout: 45_000 })
    await expect(page.locator('#password')).toBeVisible()
    expect(new URL(page.url()).origin, 'opening / again does not stay in the portal').not.toBe(portalOrigin)
    await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0)
    expect(oidcUserKeysAtLoad.length, '/ was loaded from the portal origin').toBeGreaterThan(0)
    expect(oidcUserKeysAtLoad.flat(), 'no oidc.user key when / opens again').toEqual([])
    expect(tenantReads, 'no GET /v1/tenant before a password is typed').toEqual([])
    await page.screenshot({ path: `${RESULTS}/UI-32-reopen.png` })
    log('UI-32 reopening / stops at the sign-in form, no GET /v1/tenant')
  })
})
