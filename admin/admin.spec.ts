import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectStatus, get, log, startLog } from './api'
import { RUN, activityOf, countOf, createVm, envOf, runNetwork, waitVm } from './fixtures'

// The API half of cases ADM-03..07 of plan.md; the admin portal screens wait for PORTAL-REDESIGN.
// ADM-06 changes a global price for a few seconds every time this module runs: on the release environment (prd), running
// the module at all needs an approved L-x (CLAUDE.md), and only until the first real customer (titan-ops status/known-state.md#first-real-customer).
test.describe.serial('admin', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  let vmId = ''
  const vmName = `rg-admvm-${RUN}`
  let originalPrice: number | null = null
  let tier = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('admin')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    if (originalPrice !== null) {
      expectStatus(await call('admin', 'PATCH', `/v1/admin/vm-offerings/${tier}/price`, { pricePerHour: originalPrice }), 204)
      log(`afterAll: price of ${tier} back to ${originalPrice}`)
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/ListAdminNetworksEndpoint.cs (Configure, Roles("platform-admin")),
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/ListAdminVmsEndpoint.cs (Configure, Roles("platform-admin")) — every tenant
  test('ADM-04 the admin lists hold beta-user resources, filtered by tenant', async () => {
    const tenant = await get('tenant', '/v1/tenant')
    const network = await runNetwork()
    const { smallTier } = await envOf()
    vmId = await createVm(vmName, smallTier, network.id)
    await waitVm('ADM vm has an instance', vmId, (v) => v.currentExistence === 'Exists')
    const networks = await get('admin', `/v1/admin/networks?tenantId=${tenant.id}`) as any[]
    expect(networks.some((n) => n.id === network.id && n.tenantId === tenant.id)).toBe(true)
    expect(networks.every((n) => n.tenantId === tenant.id)).toBe(true)
    const vms = await get('admin', '/v1/admin/vms') as any[]
    expect(vms.some((v) => v.id === vmId && v.tenantId === tenant.id)).toBe(true)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Vm/DeleteAdminVmCommandHandler.cs HandleAsync (audit action vm.delete.cross_tenant);
  // titan-ops features/activity/design.md#request-and-outcome-names — admin delete records no request in the tenant feed
  test('ADM-03 admin deletes a tenant VM: 204, an audit row, no delete request in the tenant feed', async () => {
    const reply = await call('admin', 'DELETE', `/v1/admin/vms/${vmId}`)
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    await waitVm('ADM-03 deleted', vmId, (v) => v.currentExistence === 'Deleted')
    const actions = await activityOf(vmName)
    log(`ADM-03 tenant feed for ${vmName}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.delete_requested')).toBe(0)
    expect(countOf(actions, 'vm.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/ListAuditLogEndpoint.cs (Configure: Get("v1/admin/audit-log"); HandleAsync: the limit query)
  test('ADM-07 the audit log carries the cross-tenant delete', async () => {
    const rows = await get('admin', '/v1/admin/audit-log?limit=50') as any[]
    const row = rows.find((r) => r.resourceId === vmId)
    log(`ADM-07 ${JSON.stringify(row)}`)
    expect(row.action).toBe('vm.delete.cross_tenant')
    expect(row.ownerTenantId).toBe((await get('tenant', '/v1/tenant')).id)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/GetProviderClientCertificateEndpoint.cs (Configure, Roles("platform-admin")),
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/TestAdminClusterEndpoint.cs (Configure: Post("v1/admin/clusters/test"); 200 either
  // way, stores nothing) — Titan's certificate, and a live test of the cluster's saved connection ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/ProviderClientIdentityStore.cs (Load: Convert.ToHexStringLower(SHA256.HashData(...)); only
  // the certificate leaves, GetKeyPairAsync is the worker's route) · titan-ops features/cluster/design.md#provider-client-identity ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusClusterConnectionTester.cs (TestAsync: an ArgumentException or a
  // ServiceUnavailableException is ClusterTestResult(false, null, message)) · OpenViCloud/titan-control-plane:Titan.Application/Options/ClusterOptions.cs
  // (ClusterConfig.NormalizeEndpoint "endpoint must be an https URL", ClusterConfig.NormalizeFingerprint "serverFingerprint must be a SHA-256 fingerprint") ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusClient.cs (TransportFailure: "presented certificate fingerprint" when the pin refused the
  // server) · titan-ops features/cluster/design.md#cluster-admin-page
  test('ADM-05 Titan client certificate is readable and the cluster tests ok; a wrong pin, an http endpoint or a short fingerprint is ok: false', async () => {
    const certificate = await get('admin', '/v1/admin/clusters/client-certificate')
    expect(certificate.certificatePem).toContain('BEGIN CERTIFICATE')
    expect(certificate.certificatePem).not.toContain('PRIVATE KEY')
    expect(certificate.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const { clusterId } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    const cluster = clusters.find((c) => c.clusterId === clusterId)
    log(`ADM-05 cluster of ${clusterId}: endpoint=${cluster.endpoint}`)
    const result = await call('admin', 'POST', '/v1/admin/clusters/test', { endpoint: cluster.endpoint, serverFingerprint: cluster.serverFingerprint })
    expectStatus(result, 200)
    log(`ADM-05 test: ${result.text}`)
    expect(JSON.parse(result.text).ok).toBe(true)

    const refused: Array<[string, { endpoint: string, serverFingerprint: string }, string]> = [
      ['wrong pin', { endpoint: cluster.endpoint, serverFingerprint: '0'.repeat(64) }, 'presented certificate fingerprint'],
      ['http endpoint', { endpoint: `http://${new URL(cluster.endpoint).host}`, serverFingerprint: cluster.serverFingerprint }, 'endpoint must be an https URL'],
      ['short fingerprint', { endpoint: cluster.endpoint, serverFingerprint: 'abc' }, 'serverFingerprint must be a SHA-256 fingerprint'],
    ]
    for (const [label, body, error] of refused) {
      const reply = await call('admin', 'POST', '/v1/admin/clusters/test', body)
      log(`ADM-05 ${label}: ${reply.status} ${reply.text.slice(0, 300)}`)
      expectStatus(reply, 200)
      const answer = bodyOf(reply)
      expect(answer.ok, label).toBe(false)
      expect(answer.latencyMs, label).toBeNull()
      expect(answer.error, label).toContain(error)
    }
    expect(await get('admin', '/v1/admin/clusters')).toEqual(clusters)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/UpdateVmOfferingPriceEndpoint.cs (Configure: Patch("v1/admin/vm-offerings/{offeringId}/price");
  // HandleAsync: SendNoContentAsync) — L-x on the release environment, and only until titan-ops status/known-state.md#first-real-customer ·
  // titan-ops features/billing/metering/design.md#price-patch · titan-ops architecture/tenancy-and-admin.md#admin-audit ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmOffering/UpdateVmOfferingPriceCommandHandler.cs (PriceChangeAction,
  // PriceChangeResourceType; HandleAsync: detail `<old> -> <new>`, invariant culture) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/AdminAuditLog/AdminAuditLog.cs
  // (CreatePlatform: ResourceId and OwnerTenantId Guid.Empty) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/AdminAuditLogRepository.cs
  // (ListAsync: newest first)
  test('ADM-06 admin changes a tier price: 204, the anonymous list shows it, then it is put back; two audit rows old -> new and new -> old', async () => {
    const { otherTier } = await envOf()
    tier = otherTier
    const auditBefore = new Set((await get('admin', '/v1/admin/audit-log?limit=50') as any[]).map((r) => r.id))
    const offerings = await get('anonymous', '/v1/vm-offerings') as any[]
    originalPrice = offerings.find((o) => o.id === tier).pricePerHour
    const original = originalPrice!
    const changed = original + 1
    const reply = await call('admin', 'PATCH', `/v1/admin/vm-offerings/${tier}/price`, { pricePerHour: changed })
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    expect((await get('anonymous', '/v1/vm-offerings') as any[]).find((o) => o.id === tier).pricePerHour).toBe(changed)
    expectStatus(await call('admin', 'PATCH', `/v1/admin/vm-offerings/${tier}/price`, { pricePerHour: original }), 204)
    expect((await get('anonymous', '/v1/vm-offerings') as any[]).find((o) => o.id === tier).pricePerHour).toBe(original)
    originalPrice = null

    const zero = '00000000-0000-0000-0000-000000000000'
    const rows = (await get('admin', '/v1/admin/audit-log?limit=50') as any[])
      .filter((r) => !auditBefore.has(r.id) && r.action === 'pricing.vm_offering.change')
    log(`ADM-06 new audit rows: ${JSON.stringify(rows)}`)
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.resourceType).toBe('vm_offering')
      expect(row.resourceKey).toBe(tier)
      expect(row.resourceId).toBe(zero)
      expect(row.ownerTenantId).toBe(zero)
      expect(row.detail).toMatch(/^\S+ -> \S+$/)
    }
    // Newest first: the give-back, then the change. Compared as numbers: the old price is written as the stored decimal.
    const expectPrices = (detail: string, from: number, to: number) => {
      const [was, now] = detail.split(' -> ').map(Number)
      expect(was, detail).toBeCloseTo(from, 6)
      expect(now, detail).toBeCloseTo(to, 6)
    }
    expectPrices(rows[0].detail, changed, original)
    expectPrices(rows[1].detail, original, changed)
  })
})
