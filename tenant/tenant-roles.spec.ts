import { test, expect } from '@playwright/test'
import { closeSessions, headersOf, useBrowser } from './auth'
import { log, startLog } from './api'

// Case TEN-10 of plan.md. Reads only the caller's own access token; never prints it.
test.describe.serial('tenant roles', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('tenant-roles')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  function realmRolesOf(authorization: string): string[] {
    const payload = authorization.replace(/^Bearer /, '').split('.')[1]
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return claims.realm_access?.roles ?? []
  }

  // OpenViCloud/titan-ops:docs/architecture/tenancy-and-admin.md#approval-is-activation ·
  // OpenViCloud/titan-local-cluster@ebd6a30:base/keycloak/realm-import/configmap.yaml:33 (admin-test) and :47 (beta-user) realmRoles
  test('TEN-10 the access tokens of beta-user and admin-test carry realm role auto-approve', async () => {
    const tenantRoles = realmRolesOf((await headersOf('tenant')).Authorization)
    const adminRoles = realmRolesOf((await headersOf('admin')).Authorization)
    log(`TEN-10 beta-user roles=${JSON.stringify(tenantRoles.slice().sort())} admin-test roles=${JSON.stringify(adminRoles.slice().sort())}`)
    expect(tenantRoles).toContain('auto-approve')
    expect(adminRoles).toContain('auto-approve')
  })
})
