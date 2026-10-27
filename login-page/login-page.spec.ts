import { test, expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import { PORTAL } from './auth'
import { RESULTS, log, startLog } from './api'
import { startLocalProxyIfNeeded } from './local-proxy'

// Cases LOGIN-01..10 of plan.md: the Keycloak login theme `openvicloud`, read without signing in.
// Theme: OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/.
// Nothing is submitted: register is opened, never sent.
// Every case leaves ${RESULTS}/<ID>-<what>.png; the form is empty when it is taken.

const BRAND = 'OpenViCloud'

type Scheme = 'light' | 'dark'

// A fresh context per case, browser locale en-US by default, so only ui_locales or the picker can make a page
// Vietnamese. The device page has no ui_locales from a client: it follows the browser locale.
async function open(browser: Browser, scheme: Scheme, width: number, locale = 'en-US'): Promise<{ context: BrowserContext, page: Page }> {
  await startLocalProxyIfNeeded(PORTAL)
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale })
  const page = await context.newPage()
  return { context, page }
}

// The portal sends the browser to Keycloak's login page; returns that page's URL.
async function loginUrl(page: Page): Promise<string> {
  await page.goto(PORTAL + '/', { waitUntil: 'domcontentloaded' })
  const signIn = page.getByRole('button', { name: /sign in|log ?in|đăng nhập/i }).first()
  const signInVisible = await signIn.isVisible().catch(() => false)
  if (signInVisible) {
    await signIn.click().catch(() => {})
  }
  await page.locator('#username').waitFor({ state: 'visible', timeout: 45_000 })
  return page.url()
}

// The authorize request the portal sent the browser to, where ui_locales belongs. The page it lands on can be
// Keycloak's /login-actions/authenticate (Keycloak resumes the tab it already has), and there ui_locales is ignored.
async function authorizeUrl(page: Page): Promise<string> {
  const authorizes: string[] = []
  const onRequest = (request: Request): void => {
    if (request.isNavigationRequest() && request.url().includes('/protocol/openid-connect/auth')) {
      authorizes.push(request.url())
    }
  }
  page.on('request', onRequest)
  await loginUrl(page)
  page.off('request', onRequest)
  expect(authorizes.length, 'the portal sent the browser to the authorize endpoint').toBeGreaterThan(0)
  return authorizes[authorizes.length - 1]
}

function keycloakPath(page: Page): string {
  return new URL(page.url()).pathname.replace(/.*\/realms\/[^/]+/, '')
}

function withLocale(url: string, locale: string): string {
  const next = new URL(url)
  next.searchParams.set('ui_locales', locale)
  return next.toString()
}

// Keycloak's base (…/auth) from any of its page URLs.
function keycloakBase(url: string): string {
  return url.split('/realms/')[0]
}

async function openRegister(page: Page): Promise<void> {
  await page.locator('#kc-registration a, a[href*="registration"]').first().click()
  await page.locator('#profileName').waitFor({ state: 'visible', timeout: 30_000 })
}

async function openDevice(page: Page, base: string): Promise<void> {
  await page.goto(base + '/realms/titan/device', { waitUntil: 'domcontentloaded' })
  await page.locator('#device-user-code').waitFor({ state: 'visible', timeout: 30_000 })
}

// The colour a CSS value computes to in this browser: the oracle for token comparisons.
async function computed(page: Page, cssColour: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = value
    document.body.appendChild(probe)
    const result = getComputedStyle(probe).backgroundColor
    probe.remove()
    return result
  }, cssColour)
}

async function background(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor)
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
}

async function submitLabels(page: Page): Promise<string[]> {
  return page.locator('input[type="submit"], button[type="submit"]').evaluateAll((els) =>
    els.map((el) => ((el as HTMLInputElement).value || el.textContent || '').trim()))
}

// English text of the pages in scope: OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/messages/messages_en.properties,
// and keycloak.v2's own bundle.
const ENGLISH = [
  'Sign in to your account', 'Username or email', 'New user?', 'Or sign in with',
  'Billed by the hour', 'Virtual servers.', 'Pay for the hours you use.', 'One VND invoice a month',
  'A stopped VM is not charged', 'A private network for your VMs', 'Sign up with GitHub or email',
  'Required fields', 'Confirm password', 'Profile name', 'Back to Login',
  'Device Login', 'Enter the code provided by your device',
]

// Not serial: each case opens its own context, so one red case does not hide the others.
test.describe('login-page', () => {
  test.beforeAll(() => {
    startLog('login-page')
  })

  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/resources/css/openvicloud.css:
  // row layout from 900 px, column with the panel as a band between header and form below it
  test('LOGIN-01 split layout at 1280 px, panel band above the form at 375 px', async ({ browser }) => {
    const wide = await open(browser, 'light', 1280)
    await loginUrl(wide.page)
    const panel = await wide.page.locator('aside.ovc-panel').boundingBox()
    const form = await wide.page.locator('#kc-form-login').boundingBox()
    log(`LOGIN-01 1280 panel=${JSON.stringify(panel)} form=${JSON.stringify(form)}`)
    expect(panel, 'panel visible at 1280').not.toBeNull()
    expect(form, 'form visible at 1280').not.toBeNull()
    expect(panel!.x).toBeGreaterThanOrEqual(form!.x + form!.width)
    await wide.page.screenshot({ path: `${RESULTS}/LOGIN-01-1280.png` })
    await wide.context.close()

    const narrow = await open(browser, 'light', 375)
    await loginUrl(narrow.page)
    const band = await narrow.page.locator('aside.ovc-panel').boundingBox()
    const formNarrow = await narrow.page.locator('#kc-form-login').boundingBox()
    log(`LOGIN-01 375 panel=${JSON.stringify(band)} form=${JSON.stringify(formNarrow)}`)
    expect(band, 'panel band visible at 375').not.toBeNull()
    expect(band!.y + band!.height).toBeLessThanOrEqual(formNarrow!.y)
    await expect(narrow.page.locator('.ovc-lede')).toBeHidden()
    await expect(narrow.page.locator('.ovc-points')).toBeHidden()
    const scrollWidth = await narrow.page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth, 'no horizontal scroll at 375').toBeLessThanOrEqual(375)
    await narrow.page.screenshot({ path: `${RESULTS}/LOGIN-01-375.png` })
    await narrow.context.close()
  })

  // Portal tokens: OpenViCloud/titan-cloud-console:portal/src/index.css --color-background, --color-primary (light and dark)
  test('LOGIN-02 page and button colours follow the portal tokens in light and dark', async ({ browser }) => {
    const expected: Record<Scheme, { page: string, primary: string }> = {
      light: { page: '#f3f4f7', primary: 'hsl(38 95% 52%)' },
      dark: { page: '#0d0e12', primary: 'hsl(38 95% 58%)' },
    }
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      const { context, page } = await open(browser, scheme, 1280)
      await loginUrl(page)
      const body = await background(page, 'body')
      const button = await background(page, '#kc-login')
      const wantBody = await computed(page, expected[scheme].page)
      const wantButton = await computed(page, expected[scheme].primary)
      log(`LOGIN-02 ${scheme} body=${body} want=${wantBody} button=${button} want=${wantButton}`)
      expect(body).toBe(wantBody)
      expect(button).toBe(wantButton)
      await page.screenshot({ path: `${RESULTS}/LOGIN-02-${scheme}.png` })
      await context.close()
    }
  })

  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/configmap.yaml titan.json displayName;
  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/template.ftl .ovc-brand-name
  test('LOGIN-03 brand is OpenViCloud on login, register and device, no Titan Cloud', async ({ browser }) => {
    const { context, page } = await open(browser, 'light', 1280)
    const url = await loginUrl(page)
    await expect(page).toHaveTitle(`Sign in to ${BRAND}`)
    await expect(page.locator('.ovc-brand-name')).toHaveText(BRAND)
    const pages: Array<[string, string]> = [['login', await visibleText(page)]]
    await page.screenshot({ path: `${RESULTS}/LOGIN-03-login.png` })
    await openRegister(page)
    pages.push(['register', await visibleText(page)])
    await page.screenshot({ path: `${RESULTS}/LOGIN-03-register.png` })
    await openDevice(page, keycloakBase(url))
    pages.push(['device', await visibleText(page)])
    await page.screenshot({ path: `${RESULTS}/LOGIN-03-device.png` })
    for (const [name, text] of pages) {
      log(`LOGIN-03 ${name} brand=${text.includes(BRAND)} titanCloud=${text.includes('Titan Cloud')}`)
      expect(text, name).toContain(BRAND)
      expect(text, name).not.toContain('Titan Cloud')
    }
    await context.close()
  })

  // lib/auth.ts signs in through these ids in every module
  test('LOGIN-04 the ids sign-in and device login rely on are present', async ({ browser }) => {
    const { context, page } = await open(browser, 'light', 1280)
    const url = await loginUrl(page)
    for (const id of ['#username', '#password', '#kc-login']) {
      await expect(page.locator(id), id).toHaveCount(1)
    }
    await openDevice(page, keycloakBase(url))
    await expect(page.locator('#device-user-code')).toHaveCount(1)
    await page.screenshot({ path: `${RESULTS}/LOGIN-04-device.png` })
    await context.close()
  })

  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/resources/css/openvicloud.css @font-face: Be Vietnam Pro from
  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/resources/fonts
  test('LOGIN-05 fonts come from the Keycloak host, none from Google', async ({ browser }) => {
    // The URL comes from one context; the fonts are counted in a fresh one that opens only Keycloak, so the
    // portal's own fonts (loaded before the redirect) are not counted.
    const first = await open(browser, 'light', 1280)
    const url = await loginUrl(first.page)
    await first.context.close()
    const { context, page } = await open(browser, 'light', 1280)
    const fonts: string[] = []
    const google: string[] = []
    page.on('response', (response) => {
      const url = response.url()
      if (/fonts\.(googleapis|gstatic)\.com/.test(url)) {
        google.push(url)
      }
      if (url.includes('.woff2') && response.status() === 200) {
        fonts.push(url)
      }
    })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('#username').waitFor({ state: 'visible', timeout: 45_000 })
    await page.evaluate(() => document.fonts.ready)
    const origin = new URL(url).origin
    log(`LOGIN-05 woff2=${fonts.length} google=${google.length} origin=${origin}`)
    expect(google).toEqual([])
    expect(fonts.length).toBeGreaterThan(0)
    log(`LOGIN-05 fonts ${JSON.stringify(fonts.map((font) => new URL(font).pathname))}`)
    for (const font of fonts) {
      expect(new URL(font).origin, font).toBe(origin)
    }
    // PatternFly's own fonts also load from the Keycloak host; the theme's Be Vietnam Pro must be among them.
    expect(fonts.some((font) => font.includes('/login/openvicloud/fonts/'))).toBe(true)
    const family = await page.locator('body').evaluate((el) => getComputedStyle(el).fontFamily)
    expect(family).toContain('Be Vietnam Pro')
    await page.screenshot({ path: `${RESULTS}/LOGIN-05-fonts.png` })
    await context.close()
  })

  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/configmap-user-profile.yaml: username, email, profileName
  // (optional); no firstName/lastName
  test('LOGIN-06 register asks for Username, Password, Confirm password, Email, optional Profile name', async ({ browser }) => {
    const { context, page } = await open(browser, 'light', 1280)
    await loginUrl(page)
    await openRegister(page)
    const ids = await page.locator('form#kc-register-form input:not([type="hidden"]):not([type="submit"])')
      .evaluateAll((els) => els.map((el) => el.id))
    log(`LOGIN-06 fields ${ids.join(',')}`)
    expect(ids).toEqual(['username', 'password', 'password-confirm', 'email', 'profileName'])
    const label = (await page.locator('label[for="profileName"]').innerText()).trim()
    expect(label).toBe('Profile name')
    await expect(page.locator('#profileName')).not.toHaveAttribute('aria-required', 'true')
    await expect(page.locator('#profileName')).not.toHaveAttribute('required', /.*/)
    await expect(page.locator('#firstName')).toHaveCount(0)
    await expect(page.locator('#lastName')).toHaveCount(0)
    await page.screenshot({ path: `${RESULTS}/LOGIN-06-register.png` })
    await context.close()
  })

  // realm i18n en/vi (OpenViCloud/titan-local-cluster:base/keycloak/realm-import/configmap.yaml titan.json supportedLocales);
  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/messages/messages_vi.properties;
  // an unsupported locale falls back to the default (en)
  test('LOGIN-07 ui_locales decides the language with an en-US browser; fr falls back to English', async ({ browser }) => {
    const { context, page } = await open(browser, 'light', 1280)
    const url = await authorizeUrl(page)
    await page.goto(withLocale(url, 'vi'), { waitUntil: 'domcontentloaded' })
    const lang = await page.evaluate(() => document.documentElement.lang)
    log(`LOGIN-07 vi lang=${lang} path=${keycloakPath(page)} title=${await page.title()}`)
    expect(lang).toBe('vi')
    await expect(page).toHaveTitle(`Đăng nhập vào ${BRAND}`)
    await page.screenshot({ path: `${RESULTS}/LOGIN-07-vi.png` })
    await context.close()

    const other = await open(browser, 'light', 1280)
    const otherUrl = await authorizeUrl(other.page)
    await other.page.goto(withLocale(otherUrl, 'fr'), { waitUntil: 'domcontentloaded' })
    const otherLang = await other.page.evaluate(() => document.documentElement.lang)
    log(`LOGIN-07 fr lang=${otherLang} path=${keycloakPath(other.page)} title=${await other.page.title()}`)
    expect(otherLang).toBe('en')
    await expect(other.page).toHaveTitle(`Sign in to ${BRAND}`)
    await other.page.screenshot({ path: `${RESULTS}/LOGIN-07-fr.png` })
    await other.context.close()
  })

  // Every visible string of login, register (ui_locales=vi) and device (browser vi-VN) differs from its English text
  test('LOGIN-08 no English left on the Vietnamese pages, submit labels included', async ({ browser }) => {
    const { context, page } = await open(browser, 'light', 1280)
    const url = await authorizeUrl(page)
    const englishSubmit = await submitLabels(page)
    await page.goto(withLocale(url, 'vi'), { waitUntil: 'domcontentloaded' })
    await page.locator('#username').waitFor({ state: 'visible' })
    log(`LOGIN-08 login path=${keycloakPath(page)}`)
    const texts: Array<[string, string, string[]]> = [['login', await visibleText(page), await submitLabels(page)]]
    await page.screenshot({ path: `${RESULTS}/LOGIN-08-login-vi.png` })
    await openRegister(page)
    texts.push(['register', await visibleText(page), await submitLabels(page)])
    await page.screenshot({ path: `${RESULTS}/LOGIN-08-register-vi.png` })
    const device = await open(browser, 'light', 1280, 'vi-VN')
    await openDevice(device.page, keycloakBase(url))
    const deviceLang = await device.page.evaluate(() => document.documentElement.lang)
    log(`LOGIN-08 device lang=${deviceLang}`)
    expect(deviceLang).toBe('vi')
    texts.push(['device', await visibleText(device.page), await submitLabels(device.page)])
    await device.page.screenshot({ path: `${RESULTS}/LOGIN-08-device-vi.png` })
    await device.context.close()
    log(`LOGIN-08 en submit=${JSON.stringify(englishSubmit)}`)
    for (const [name, text, submits] of texts) {
      const left = ENGLISH.filter((phrase) => text.includes(phrase))
      log(`LOGIN-08 ${name} submit=${JSON.stringify(submits)} english=${JSON.stringify(left)}`)
      expect(left, name).toEqual([])
      expect(submits.length, `${name} has a submit`).toBeGreaterThan(0)
      for (const submit of submits) {
        expect(['Sign In', 'Register', 'Submit', 'Log in'], `${name} submit "${submit}"`).not.toContain(submit)
      }
    }
    expect(englishSubmit).toContain('Sign In')
    await context.close()
  })

  // OpenViCloud/titan-cloud-console:portal/src/i18n/lang.ts signinArgs: ui_locales from the saved ovc-lang, none with nothing saved
  test('LOGIN-10 the portal sends its saved language to Keycloak, and nothing when none is saved', async ({ browser }) => {
    const saved = await open(browser, 'light', 1280)
    await saved.context.addInitScript(() => {
      window.localStorage.setItem('ovc-lang', 'vi')
    })
    const savedUrl = await authorizeUrl(saved.page)
    log(`LOGIN-10 saved=vi ui_locales=${new URL(savedUrl).searchParams.get('ui_locales')} title=${await saved.page.title()}`)
    expect(new URL(savedUrl).searchParams.get('ui_locales')).toBe('vi')
    await expect(saved.page).toHaveTitle(`Đăng nhập vào ${BRAND}`)
    await saved.page.screenshot({ path: `${RESULTS}/LOGIN-10-saved-vi.png` })
    await saved.context.close()

    const none = await open(browser, 'light', 1280)
    const noneUrl = await authorizeUrl(none.page)
    log(`LOGIN-10 saved=none ui_locales=${new URL(noneUrl).searchParams.get('ui_locales')} title=${await none.page.title()}`)
    expect(new URL(noneUrl).searchParams.has('ui_locales')).toBe(false)
    await expect(none.page).toHaveTitle(`Sign in to ${BRAND}`)
    await none.page.screenshot({ path: `${RESULTS}/LOGIN-10-none-en.png` })
    await none.context.close()

    // Nothing saved and a Vietnamese browser: Keycloak follows the browser.
    const browserVi = await open(browser, 'light', 1280, 'vi-VN')
    const browserViUrl = await authorizeUrl(browserVi.page)
    log(`LOGIN-10 saved=none browser=vi-VN ui_locales=${new URL(browserViUrl).searchParams.get('ui_locales')} title=${await browserVi.page.title()}`)
    expect(new URL(browserViUrl).searchParams.has('ui_locales')).toBe(false)
    await expect(browserVi.page).toHaveTitle(`Đăng nhập vào ${BRAND}`)
    await browserVi.page.screenshot({ path: `${RESULTS}/LOGIN-10-none-browser-vi.png` })
    await browserVi.context.close()
  })

  // OpenViCloud/titan-local-cluster:base/keycloak/realm-import/theme/openvicloud/login/template.ftl #login-select-toggle:
  // options from the realm's supported locales
  test('LOGIN-09 the language picker offers English and Tiếng Việt and switches the page', async ({ browser }) => {
    const { context, page } = await open(browser, 'light', 1280)
    await loginUrl(page)
    const options = await page.locator('#login-select-toggle option').evaluateAll((els) =>
      els.map((el) => (el.textContent || '').trim()))
    log(`LOGIN-09 options ${JSON.stringify(options)}`)
    expect(options.length).toBe(2)
    expect(options.some((o) => o.startsWith('English'))).toBe(true)
    const vi = options.findIndex((o) => o.includes('Tiếng Việt'))
    expect(vi).toBeGreaterThanOrEqual(0)
    await Promise.all([
      page.waitForURL(/kc_locale=vi|ui_locales=vi/, { timeout: 30_000 }),
      page.locator('#login-select-toggle').selectOption({ index: vi }),
    ])
    await page.locator('#username').waitFor({ state: 'visible' })
    await expect(page).toHaveTitle(`Đăng nhập vào ${BRAND}`)
    await page.screenshot({ path: `${RESULTS}/LOGIN-09-picked-vi.png` })
    await context.close()
  })
})
