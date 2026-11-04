import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectStatus, log, startLog } from './api'

// Case ADM-14 of plan.md. Read only. ADM-15 (the same route with the worker stopped) is admin/stuck-requests/, a job of
// its own: it needs the agent to stop and start the incus-worker outside the runner.
test.describe.serial('admin-stuck-requests', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('admin-stuck-requests')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  // titan-ops architecture/resource-lifecycle.md#lost-and-stale · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/ListStuckRequestsEndpoint.cs
  // (Configure: Get("v1/admin/requests/stuck"), Roles("platform-admin")) · OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Request/Contracts/StuckRequestQueryResult.cs
  // (StuckRequestQueryResult) · OpenViCloud/titan-control-plane:Titan.Application/Options/RequestStuckOptions.cs (ThresholdMinutes = 15) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/PendingRequestReader.cs (ListStuckAsync: asked_at < now - threshold)
  test('ADM-14 GET /v1/admin/requests/stuck is 200 with an array for admin-test, 403 for beta-user', async () => {
    const reply = await call('admin', 'GET', '/v1/admin/requests/stuck')
    log(`ADM-14 admin: ${reply.status} ${reply.text.slice(0, 500)}`)
    expectStatus(reply, 200)
    const rows = bodyOf(reply)
    expect(Array.isArray(rows)).toBe(true)
    const threshold = Date.now() - 15 * 60_000
    for (const row of rows as any[]) {
      expect(Object.keys(row).sort()).toEqual(['askedAt', 'commandStatus', 'id', 'kind', 'requestId', 'resource', 'tenantId'])
      expect(Date.parse(row.askedAt), `${row.resource} ${row.id} asked at ${row.askedAt}`).toBeLessThan(threshold)
    }
    const tenant = await call('tenant', 'GET', '/v1/admin/requests/stuck')
    log(`ADM-14 beta-user: ${tenant.status}`)
    expectStatus(tenant, 403)
  })
})
