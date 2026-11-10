import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, expectError, expectStatus, get, log, startLog } from './api'

// Cases TEN-08, TEN-09 of plan.md. All 9 caps are read before each test and restored in finally,
// so a buggy bind (TEN-09) can never leave the tenant's quota changed.

const CAPS = [
  'maxVms', 'maxNetworks', 'maxVolumes', 'maxVmSnapshotsPerVm', 'maxVolumeSnapshotsPerVolume',
  'maxFirewallRulesPerNetwork', 'maxPublicIpv6', 'maxSshKeys', 'maxLoadBalancers',
] as const

type Quota = Record<(typeof CAPS)[number], number>

function quotaOf(row: any): Quota {
  const quota = {} as Quota
  for (const cap of CAPS) {
    quota[cap] = row[cap]
  }
  return quota
}

async function ownRow(tenantId: string): Promise<any> {
  const all = await get('admin', '/v1/tenants') as any[]
  const row = all.find((t) => t.id === tenantId)
  expect(row, `tenant ${tenantId} in GET /v1/tenants`).toBeDefined()
  return row
}

test.describe.serial('tenant-quota', () => {
  test.describe.configure({ timeout: 5 * 60_000 })

  let tenantId = ''
  let original: Quota | null = null

  test.beforeAll(async ({ browser }) => {
    startLog('tenant-quota')
    useBrowser(browser)
    const own = await get('tenant', '/v1/tenant')
    tenantId = own.id
    original = quotaOf(await ownRow(tenantId))
    log(`original quota: ${JSON.stringify(original)}`)
  })

  test.afterAll(async () => {
    if (original !== null) {
      expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, original), 204)
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs (UpdateQuotaRequest) — an absent optional cap
  // (UpdateTenantQuotaCommandHandler: command.MaxX ?? current.MaxX) is kept as it is; only maxVms/maxNetworks are mandatory.
  test('TEN-08 PATCH quota with only maxVms and maxNetworks keeps the other 7 caps', async () => {
    const before = original!
    const changed = { maxVms: before.maxVms + 1, maxNetworks: before.maxNetworks }
    const reply = await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, changed)
    expectStatus(reply, 204)
    expect(reply.text).toBe('')

    const after = quotaOf(await ownRow(tenantId))
    expect(after.maxVms).toBe(changed.maxVms)
    expect(after.maxNetworks).toBe(changed.maxNetworks)
    for (const cap of CAPS) {
      if (cap === 'maxVms' || cap === 'maxNetworks') {
        continue
      }
      expect(after[cap], `${cap} must stay as it was before PATCH, not fall back to a default`).toBe(before[cap])
    }

    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, before), 204)
    expect(quotaOf(await ownRow(tenantId))).toEqual(before)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Tenant/UpdateTenantQuotaEndpoint.cs UpdateQuotaValidator — maxVms and maxNetworks are NotNull(); a request missing one never reaches
  // the handler, so a bind bug cannot turn an absent field into a silent 0.
  test('TEN-09 PATCH quota missing maxVms is 400 VALIDATION_ERROR and changes nothing', async () => {
    const before = original!
    const reply = await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, { maxNetworks: before.maxNetworks })
    expectError(reply, 400, 'VALIDATION_ERROR')
    expect(quotaOf(await ownRow(tenantId))).toEqual(before)
  })
})
