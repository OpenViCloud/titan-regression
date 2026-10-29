import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, expectError, expectStatus, get, log, startLog } from './api'

// Cases TEN-01..06 of plan.md. Quota and status are put back as they were in afterAll.
test.describe.serial('tenant', () => {
  test.describe.configure({ timeout: 5 * 60_000 })

  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null

  test.beforeAll(async ({ browser }) => {
    startLog('tenant')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    if (originalQuota !== null) {
      expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Tenant/Contracts/TenantQueryResult.cs (TenantQueryResult, From) — the caller's view and
  // the admin list share one shape
  test('TEN-01 GET /v1/tenant carries maxVms, maxNetworks, maxVolumes, maxPublicIpv6, debtCeiling, the same as the admin list', async () => {
    const own = await get('tenant', '/v1/tenant')
    tenantId = own.id
    originalQuota = { maxVms: own.maxVms, maxNetworks: own.maxNetworks }
    const all = await get('admin', '/v1/tenants') as any[]
    const row = all.find((t) => t.id === own.id)
    log(`TEN-01 own=${JSON.stringify({ maxVms: own.maxVms, maxNetworks: own.maxNetworks, maxVolumes: own.maxVolumes, maxPublicIpv6: own.maxPublicIpv6, debtCeiling: own.debtCeiling })}`)
    expect(row.maxVms).toBe(own.maxVms)
    expect(row.maxNetworks).toBe(own.maxNetworks)
    expect(row.debtCeiling).toBe(own.debtCeiling)
    expect(own.debtCeiling).toBeGreaterThanOrEqual(0)
    expect(row.maxVolumes).toBe(own.maxVolumes)
    expect(row.maxPublicIpv6).toBe(own.maxPublicIpv6)
    expect(own.maxVolumes).toBeGreaterThanOrEqual(0)
    expect(own.maxPublicIpv6).toBeGreaterThanOrEqual(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs (UpdateQuotaRequest; Configure: Patch("v1/tenants/{tenantId:guid}/quota"))
  test('TEN-02 admin PATCH quota is 204 and the tenant reads the new caps', async () => {
    const changed = { maxVms: originalQuota!.maxVms + 1, maxNetworks: originalQuota!.maxNetworks }
    const reply = await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, changed)
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    const own = await get('tenant', '/v1/tenant')
    expect(own.maxVms).toBe(changed.maxVms)
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
    expect((await get('tenant', '/v1/tenant')).maxVms).toBe(originalQuota!.maxVms)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs UpdateQuotaValidator (GreaterThanOrEqualTo(0))
  test('TEN-03 a negative cap is 400 VALIDATION_ERROR and changes nothing', async () => {
    expectError(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, { maxVms: -1, maxNetworks: originalQuota!.maxNetworks }),
      400, 'VALIDATION_ERROR')
    expect((await get('tenant', '/v1/tenant')).maxVms).toBe(originalQuota!.maxVms)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantStatusEndpoint.cs (Configure: Patch("v1/tenants/{tenantId:guid}/status");
  // HandleAsync: SendNoContentAsync) · titan-ops features/tenant/design.md#tenant-status-repeats
  test('TEN-04 Active on an Active tenant is 204 and it stays Active', async () => {
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/status`, { status: 'Active' }), 204)
    expect((await get('tenant', '/v1/tenant')).status).toBe('Active')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Legal/GetLegalDocumentEndpoint.cs (Configure: Get("v1/legal/document"), AllowAnonymous),
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Legal/GetConsentStatusEndpoint.cs (Configure: Get("v1/legal/consent-status"));
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Legal/Contracts/ConsentStatusQueryResult.cs (ConsentStatusQueryResult)
  test('TEN-05 the current terms are readable and consent status names that version', async () => {
    const document = await get('anonymous', '/v1/legal/document')
    log(`TEN-05 document key=${document.key} version=${document.version}`)
    expect(document.content.length).toBeGreaterThan(0)
    const status = await get('tenant', '/v1/legal/consent-status')
    expect(typeof status.mustAcceptTerms).toBe('boolean')
    expect(status.documentKey).toBe(document.key)
    expect(status.documentVersion).toBe(document.version)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Legal/GetLegalDocumentQueryHandler.cs (GetLegalDocumentQueryHandler) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Legal/GetLegalDocumentEndpoint.cs (GetLegalDocumentEndpoint) (titan-ops features/legal/design.md#legal-endpoints)
  test('TEN-07 the terms come in English by default and in Vietnamese on request, under one version', async () => {
    const english = await get('anonymous', '/v1/legal/document')
    const vietnamese = await get('anonymous', '/v1/legal/document?lang=vi')
    const unknown = await get('anonymous', '/v1/legal/document?lang=fr')
    log(`TEN-07 en="${english.title}" vi="${vietnamese.title}" version=${english.version}`)
    expect(english.lang).toBe('en')
    expect(vietnamese.lang).toBe('vi')
    expect(unknown.lang).toBe('en')
    expect(vietnamese.version).toBe(english.version)
    expect(vietnamese.effectiveAt).toBe(english.effectiveAt)
    expect(vietnamese.title).not.toBe(english.title)
    expect(vietnamese.content).not.toBe(english.content)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/ListMembersEndpoint.cs (Configure: Get("v1/tenant/members"))
  test('TEN-06 the tenant lists its members', async () => {
    const members = await get('tenant', '/v1/tenant/members') as any[]
    log(`TEN-06 members: ${members.length}`)
    expect(members.length).toBeGreaterThan(0)
  })
})
