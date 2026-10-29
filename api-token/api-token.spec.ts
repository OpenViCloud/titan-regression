import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, startLog } from './api'
import { cleanUp } from './clean-up'
import { activityOf, countOf, nameOf } from './fixtures'
import { callWithToken, newSecret } from './token'

// Cases TOK-01..05 of plan.md, and ACT-02 for API tokens. The first token (rg-tok-<run>) is created with beta-user's JWT,
// the second (rg-tok2-<run>) through the first; afterAll deletes both. A create TOK-03 expects refused but that
// succeeds is left to cleanup, which sweeps rg-* tokens.
test.describe.serial('api-token', () => {
  test.describe.configure({ timeout: 5 * 60_000 })

  const firstName = nameOf('tok')
  const secondName = nameOf('tok2')
  const firstSecret = newSecret()
  const secondSecret = newSecret()
  let firstId = ''
  let secondId = ''
  let tenantId = ''
  let countBefore = 0

  test.beforeAll(async ({ browser }) => {
    startLog('api-token')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(5 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = []
    for (const id of [secondId, firstId]) {
      if (id !== '') {
        steps.push([`delete token ${id}`, async () => {
          const reply = await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${id}`)
          expect([204, 404], `${reply.url} → ${reply.text.slice(0, 200)}`).toContain(reply.status)
        }])
      }
    }
    steps.push(['close sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/ApiToken/CreateApiTokenEndpoint.cs (SendAsync(result, 201));
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Platform/ApiToken/ApiToken.cs (Create: Prefix = secret[..PrefixLength],
  // ExpiresAt = now.AddDays); OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/ApiToken/Contracts/ApiTokenQueryResult.cs
  // (ApiTokenQueryResult: never the secret nor its hash) · titan-ops features/public-api/design.md#api-token
  test('TOK-01 create is 201 {apiTokenId}; the list shows prefix and a 90-day expiry, never the secret or its hash', async () => {
    tenantId = (await get('tenant', '/v1/tenant')).id
    countBefore = (await get('tenant', '/v1/tenant/api-tokens') as any[]).length
    const reply = await call('tenant', 'POST', '/v1/tenant/api-tokens', { name: firstName, token: firstSecret, expiresInDays: 90 }, newKey())
    expectStatus(reply, 201)
    const body = bodyOf(reply)
    firstId = body.apiTokenId
    expect(Object.keys(body)).toEqual(['apiTokenId'])
    const list = await get('tenant', '/v1/tenant/api-tokens') as any[]
    const row = list.find((t) => t.id === firstId)
    log(`TOK-01 id=${firstId} keys=${Object.keys(row).sort().join(',')} prefix-length=${row.prefix.length} createdAt=${row.createdAt} expiresAt=${row.expiresAt}`)
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name', 'prefix'])
    expect(row.name).toBe(firstName)
    expect(row.prefix).toBe(firstSecret.slice(0, 8))
    expect(Date.parse(row.expiresAt) - Date.parse(row.createdAt)).toBe(90 * 24 * 3600_000)
    const hash = createHash('sha256').update(firstSecret, 'utf8').digest('hex')
    const text = JSON.stringify(list)
    expect(text.includes(firstSecret)).toBe(false)
    expect(text.includes(hash)).toBe(false)
    // ACT-02: one request row, one outcome row (titan-ops features/activity/design.md#request-and-outcome-names)
    const actions = await activityOf(firstName)
    log(`ACT-02 api token ${firstName}: ${actions.join(', ')}`)
    expect(countOf(actions, 'api_token.create_requested')).toBe(1)
    expect(countOf(actions, 'api_token.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/ApiTokenSchemes.cs (ReadToken: scheme word without regard to case);
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/ApiTokenAuthenticationHandler.cs (HandleAuthenticateAsync: only `sub`, no role)
  test('TOK-02 the token reads the same tenant as the JWT, lowercase bearer too; an admin route is 403', async () => {
    const asToken = await callWithToken(firstSecret, 'GET', '/v1/tenant')
    expectStatus(asToken, 200)
    expect(bodyOf(asToken).id).toBe(tenantId)
    expectStatus(await callWithToken(firstSecret, 'GET', '/v1/tenant/api-tokens'), 200)
    const lower = await callWithToken(firstSecret, 'GET', '/v1/tenant', undefined, undefined, 'bearer')
    expectStatus(lower, 200)
    expect(bodyOf(lower).id).toBe(tenantId)
    expectStatus(await callWithToken(firstSecret, 'GET', '/v1/tenant/api-tokens', undefined, undefined, 'bearer'), 200)
    const admin = await callWithToken(firstSecret, 'GET', '/v1/tenants')
    log(`TOK-02 tenant=${asToken.status} lowercase=${lower.status} /v1/tenants=${admin.status}`)
    expectStatus(admin, 403)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Platform/ApiToken/CreateApiTokenCommandHandler.cs (HandleAsync:
  // API_TOKEN_NAME_TAKEN, then API_TOKEN_EXISTS); OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/ApiToken/CreateApiTokenEndpoint.cs
  // (CreateApiTokenValidator: ovc_ + 43 base64url, 30/90/365 or null); OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/IdempotencyMiddleware.cs
  // (Replay) · titan-ops architecture/http-contract.md#idempotency-key
  test('TOK-03 a second token through the token: replay, name taken, secret taken, malformed, bad lifetime, no key', async () => {
    const key = newKey()
    const data = { name: secondName, token: secondSecret, expiresInDays: null }
    const created = await callWithToken(firstSecret, 'POST', '/v1/tenant/api-tokens', data, key)
    expectStatus(created, 201)
    secondId = bodyOf(created).apiTokenId
    const replay = await callWithToken(firstSecret, 'POST', '/v1/tenant/api-tokens', data, key)
    expectStatus(replay, 201)
    expect(bodyOf(replay).apiTokenId).toBe(secondId)
    const second = (await get('tenant', '/v1/tenant/api-tokens') as any[]).find((t) => t.id === secondId)
    expect(second.expiresAt).toBeNull()
    expectError(await callWithToken(firstSecret, 'POST', '/v1/tenant/api-tokens',
      { name: secondName, token: newSecret(), expiresInDays: 30 }, newKey()), 409, 'API_TOKEN_NAME_TAKEN')
    expectError(await callWithToken(firstSecret, 'POST', '/v1/tenant/api-tokens',
      { name: nameOf('tok3'), token: secondSecret, expiresInDays: 30 }, newKey()), 409, 'API_TOKEN_EXISTS')
    expectError(await callWithToken(firstSecret, 'POST', '/v1/tenant/api-tokens',
      { name: nameOf('tok4'), token: 'ovc_short', expiresInDays: 30 }, newKey()), 400, 'VALIDATION_ERROR')
    expectError(await callWithToken(firstSecret, 'POST', '/v1/tenant/api-tokens',
      { name: nameOf('tok5'), token: newSecret(), expiresInDays: 7 }, newKey()), 400, 'VALIDATION_ERROR')
    expectError(await callWithToken(firstSecret, 'POST', '/v1/tenant/api-tokens',
      { name: nameOf('tok6'), token: newSecret(), expiresInDays: 30 }), 400, 'IDEMPOTENCY_KEY_REQUIRED')
    const count = (await get('tenant', '/v1/tenant/api-tokens') as any[]).length
    log(`TOK-03 second=${secondId} replay=${bodyOf(replay).apiTokenId} tokens before=${countBefore} now=${count}`)
    expect(count).toBe(countBefore + 2)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Platform/ApiToken/DeleteApiTokenCommandHandler.cs (HandleAsync: the row goes,
  // a repeat is API_TOKEN_NOT_FOUND); OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/ApiTokenAuthenticationHandler.cs (Unknown API token)
  test('TOK-04 delete is 204, the deleted token is 401, a repeat is 404 API_TOKEN_NOT_FOUND', async () => {
    const deleted = await callWithToken(firstSecret, 'DELETE', `/v1/tenant/api-tokens/${secondId}`)
    expectStatus(deleted, 204)
    const after = await callWithToken(secondSecret, 'GET', '/v1/tenant')
    const repeat = await callWithToken(firstSecret, 'DELETE', `/v1/tenant/api-tokens/${secondId}`)
    log(`TOK-04 delete=${deleted.status} deleted-token=${after.status} repeat=${repeat.status}`)
    expectStatus(after, 401)
    expectError(repeat, 404, 'API_TOKEN_NOT_FOUND')
    secondId = ''
    // ACT-02, ACT-03: one row of each kind — the replay of TOK-03 and the refused repeat add none
    const actions = await activityOf(secondName)
    log(`ACT-02 api token ${secondName}: ${actions.join(', ')}`)
    for (const action of ['api_token.create_requested', 'api_token.created', 'api_token.delete_requested', 'api_token.deleted']) {
      expect(countOf(actions, action), action).toBe(1)
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Auth/ApiTokenAuthenticationHandler.cs (HandleAuthenticateAsync: Malformed API token,
  // Unknown API token ⇒ AuthenticateResult.Fail)
  test('TOK-05 an unknown well-formed token and a cut-off ovc_ are 401, not 500', async () => {
    const unknown = await callWithToken(newSecret(), 'GET', '/v1/tenant')
    const cut = await callWithToken('ovc_', 'GET', '/v1/tenant')
    log(`TOK-05 unknown=${unknown.status} cut=${cut.status}`)
    expectStatus(unknown, 401)
    expectStatus(cut, 401)
  })
})
