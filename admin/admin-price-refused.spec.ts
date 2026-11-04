import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, expectError, get, log, startLog } from './api'
import { envOf } from './fixtures'

// Case ADM-16 of plan.md: every PATCH is refused, so no price changes; unlike ADM-06 it may run on prd after the first
// real customer (titan-ops status/known-state.md#first-real-customer) — the module that holds it may not, while
// admin.spec.ts holds ADM-06.
test.describe.serial('admin-price-refused', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('admin-price-refused')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  // titan-ops features/billing/metering/design.md#price-patch ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/UpdateVmOfferingPriceEndpoint.cs (UpdateVmOfferingPriceValidator: GreaterThan(0m)) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmOffering/UpdateVmOfferingPriceCommandHandler.cs (HandleAsync: VM_OFFERING_NOT_FOUND
  // before auditLog.Add; PriceChangeAction)
  test('ADM-16 a price of 0 or -1 is 400 VALIDATION_ERROR, an unknown tier 404 VM_OFFERING_NOT_FOUND; prices and audit log unchanged', async () => {
    const { smallTier } = await envOf()
    const offeringsBefore = await get('anonymous', '/v1/vm-offerings')
    const auditBefore = new Set((await get('admin', '/v1/admin/audit-log?limit=50') as any[]).map((r) => r.id))

    for (const pricePerHour of [0, -1]) {
      const reply = await call('admin', 'PATCH', `/v1/admin/vm-offerings/${smallTier}/price`, { pricePerHour })
      log(`ADM-16 ${smallTier} ${pricePerHour}: ${reply.status} ${reply.text.slice(0, 300)}`)
      expectError(reply, 400, 'VALIDATION_ERROR')
    }
    const unknown = await call('admin', 'PATCH', '/v1/admin/vm-offerings/khong-co/price', { pricePerHour: 1 })
    log(`ADM-16 khong-co: ${unknown.status} ${unknown.text.slice(0, 300)}`)
    expectError(unknown, 404, 'VM_OFFERING_NOT_FOUND')

    expect(await get('anonymous', '/v1/vm-offerings')).toEqual(offeringsBefore)
    const added = (await get('admin', '/v1/admin/audit-log?limit=50') as any[])
      .filter((r) => !auditBefore.has(r.id) && r.action === 'pricing.vm_offering.change')
    expect(added).toEqual([])
  })
})
