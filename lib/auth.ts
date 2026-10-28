import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { startLocalProxyIfNeeded } from './local-proxy'

// Sign-in runs INSIDE the runner pod: the pod reads the test-account passwords from secretKeyRef, the browser
// types them, and the bearer token is read from the session. Neither is ever printed.
export const PORTAL = process.env.PORTAL_BASE_URL || 'http://portal.localhost:8080'
export const ADMIN = process.env.ADMIN_BASE_URL || 'http://admin.localhost:8080'

// An access token lives ~10 minutes; sign in again when less than this is left.
const REFRESH_BEFORE_MS = 2 * 60_000

type Role = 'tenant' | 'admin'

type Session = {
  context: BrowserContext
  page: Page
  token: string
  expiresAt: number
}

let browserRef: Browser | null = null
const sessions: Record<Role, Session | null> = { tenant: null, admin: null }
// Contexts of sessions a refresh replaced. Kept open until closeSessions: a spec may still hold a page of one
// (pageOf before a long wait, then any API call re-signs in), and closing it under the spec kills that page.
const replaced: BrowserContext[] = []

function need(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`${key} is not set — the runner injects it`)
  }
  return value
}

function hostOf(role: Role): string {
  if (role === 'admin') {
    return ADMIN
  }
  return PORTAL
}

function credentialsOf(role: Role): { user: string, password: string } {
  if (role === 'admin') {
    return { user: process.env.ADMIN_TEST_USERNAME || 'admin-test', password: need('ADMIN_TEST_PASSWORD') }
  }
  return { user: process.env.BETA_USER_USERNAME || 'beta-user', password: need('BETA_USER_PASSWORD') }
}

async function login(page: Page, host: string, user: string, password: string): Promise<void> {
  await page.goto(host + '/', { waitUntil: 'domcontentloaded' })
  const signIn = page.getByRole('button', { name: /sign in|log ?in|đăng nhập/i }).first()
  const signInVisible = await signIn.isVisible().catch(() => false)
  if (signInVisible) {
    await signIn.click().catch(() => {})
  }
  const username = page.locator('#username, input[name="username"]').first()
  await username.waitFor({ state: 'visible', timeout: 45_000 })
  await username.fill(user)
  await page.locator('#password, input[name="password"]').first().fill(password)
  await page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click()
  // Compare origins: on a real host (prd) the portal host also appears, unencoded, inside Keycloak's redirect_uri.
  const origin = new URL(host).origin
  await page.waitForURL((url) => url.origin === origin, { timeout: 45_000 })
}

async function tokenFrom(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (key !== null && key.startsWith('oidc.user:')) {
          return true
        }
      }
    }
    return false
  }, null, { timeout: 45_000 })
  const token = await page.evaluate(() => {
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)!
        if (!key.startsWith('oidc.user:')) {
          continue
        }
        const value = JSON.parse(store.getItem(key) || '{}')
        if (value.access_token) {
          return value.access_token as string
        }
      }
    }
    return ''
  })
  expect(token, 'a bearer token must be readable from the session').not.toEqual('')
  return token
}

function expiryOf(token: string): number {
  const payload = token.split('.')[1]
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  return claims.exp * 1000
}

async function signIn(role: Role): Promise<Session> {
  if (browserRef === null) {
    throw new Error('call useBrowser(browser) in beforeAll first')
  }
  await startLocalProxyIfNeeded(PORTAL)
  const old = sessions[role]
  if (old !== null) {
    replaced.push(old.context)
  }
  const context = await browserRef.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const { user, password } = credentialsOf(role)
  await login(page, hostOf(role), user, password)
  const token = await tokenFrom(page)
  const session = { context, page, token, expiresAt: expiryOf(token) }
  sessions[role] = session
  return session
}

export function useBrowser(browser: Browser): void {
  browserRef = browser
}

// The Authorization header of a role, signing in first, or again when the token is about to expire.
export async function headersOf(role: Role): Promise<Record<string, string>> {
  let session = sessions[role]
  if (session === null || session.expiresAt - Date.now() < REFRESH_BEFORE_MS) {
    session = await signIn(role)
  }
  return { Authorization: `Bearer ${session.token}` }
}

// After a 401: the token was refused before its expiry (Keycloak restarted, session revoked).
export async function forceSignIn(role: Role): Promise<void> {
  await signIn(role)
}

export async function pageOf(role: Role): Promise<Page> {
  await headersOf(role)
  return sessions[role]!.page
}

export async function closeSessions(): Promise<void> {
  for (const context of replaced.splice(0)) {
    await context.close()
  }
  for (const role of ['tenant', 'admin'] as Role[]) {
    const session = sessions[role]
    if (session !== null) {
      await session.context.close()
      sessions[role] = null
    }
  }
}
