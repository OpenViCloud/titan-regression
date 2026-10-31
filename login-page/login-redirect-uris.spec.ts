import { test, expect } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { ADMIN, PORTAL } from './auth'
import { log, startLog } from './api'
import { startLocalProxyIfNeeded } from './local-proxy'
import { portalConfigOf } from './portal-config'

// Case LOGIN-11 of plan.md: the redirect URIs Keycloak accepts per client are the environment's own origins.
// Plain HTTP, no browser, nothing is signed in or submitted.
test.describe.serial('login redirect URIs', () => {
  test.beforeAll(async () => {
    startLog('login-redirect-uris')
    await startLocalProxyIfNeeded(PORTAL)
  })

  async function authorize(clientId: string, redirectUri: string): Promise<{ status: number, body: string }> {
    const config = await portalConfigOf(PORTAL)
    const verifier = randomBytes(32).toString('base64url')
    const url = new URL(`${config.keycloakUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/auth`)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    const res = await fetch(url, { redirect: 'manual' })
    const body = await res.text()
    log(`LOGIN-11 ${clientId} redirect_uri=${redirectUri} status=${res.status} username=${body.includes('id="username"')}`)
    return { status: res.status, body }
  }

  function expectLoginForm(reply: { status: number, body: string }): void {
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('id="username"')
  }

  function expectRefused(reply: { status: number, body: string }): void {
    expect(reply.status).toBe(400)
    expect(reply.body).toContain('Invalid parameter: redirect_uri')
    expect(reply.body).not.toContain('id="username"')
  }

  // OpenViCloud/titan-ops:docs/architecture/platform-infra.md#keycloak-realm-as-code ·
  // OpenViCloud/titan-local-cluster@ebd6a30:base/keycloak/realm-import/configmap.yaml:68 (titan-portal redirectUris) and :94 (titan-admin-portal)
  test('LOGIN-11 each client accepts its own origin of the environment and refuses a foreign one', async () => {
    expectLoginForm(await authorize('titan-portal', `${PORTAL}/`))
    expectRefused(await authorize('titan-portal', 'https://example.invalid/'))
    expectLoginForm(await authorize('titan-admin-portal', `${ADMIN}/`))
    expectRefused(await authorize('titan-admin-portal', `${PORTAL}/`))
  })
})
