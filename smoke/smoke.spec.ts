import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, expectStatus, get, log, startLog } from './api'
import { RUN_NETWORK_PREFIX } from './fixtures'

// Cases SMOKE-01..05 of plan.md. Runs first: a red here means the env, not a feature.
test.describe.serial('smoke', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('smoke')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Host/Program.cs (MapHealthChecks("/healthz"), MapHealthChecks("/healthz/reconcilers"))
  test('SMOKE-01 healthz and reconcilers are healthy', async () => {
    const health = await call('anonymous', 'GET', '/healthz')
    expectStatus(health, 200)
    const reconcilers = await call('anonymous', 'GET', '/healthz/reconcilers')
    log(`SMOKE-01 /healthz/reconcilers ${reconcilers.status} ${reconcilers.text.slice(0, 300)}`)
    expectStatus(reconcilers, 200)
    expect(reconcilers.text).toContain('Healthy')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/ListClustersEndpoint.cs (Configure, AllowAnonymous)
  test('SMOKE-02 clusters are listed without a token', async () => {
    const clusters = await get('anonymous', '/v1/clusters') as Array<{ id: string }>
    log(`SMOKE-02 clusters ${clusters.map((z) => z.id).join(',')}`)
    expect(clusters.length).toBeGreaterThan(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/ListVmOfferingsEndpoint.cs (Configure, AllowAnonymous),
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/ListVolumeOfferingsEndpoint.cs (Configure, AllowAnonymous)
  test('SMOKE-03 offerings are listed with prices without a token', async () => {
    const vmOfferings = await get('anonymous', '/v1/vm-offerings') as Array<{ id: string, pricePerHour: number }>
    expect(vmOfferings.length).toBeGreaterThan(0)
    for (const offering of vmOfferings) {
      expect(offering.pricePerHour, `price of ${offering.id}`).toBeGreaterThan(0)
    }
    const volumeOfferings = await get('anonymous', '/v1/volume-offerings') as Array<{ id: string, pricePerGbPerHour: number }>
    expect(volumeOfferings.length).toBeGreaterThan(0)
    for (const offering of volumeOfferings) {
      expect(offering.pricePerGbPerHour, `price of ${offering.id}`).toBeGreaterThan(0)
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Tenant/Contracts/TenantQueryResult.cs (TenantQueryResult: Status, no provider account)
  test('SMOKE-04 beta-user signs in and its tenant is Active', async () => {
    const tenant = await get('tenant', '/v1/tenant')
    log(`SMOKE-04 tenant status=${tenant.status} maxVms=${tenant.maxVms} maxNetworks=${tenant.maxNetworks}`)
    expect(tenant.status).toBe('Active')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmRepository.cs ListByTenantAsync,
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VolumeRepository.cs ListByTenantAsync — lists hide Deleted; the run network may stay (CLAUDE.md)
  test('SMOKE-05 no test resource is left from an earlier run, and there is room for the run network', async () => {
    const tenant = await get('tenant', '/v1/tenant')
    const networks = await get('tenant', '/v1/tenant/networks') as Array<{ name: string }>
    const vms = await get('tenant', '/v1/tenant/vms') as Array<{ name: string }>
    const volumes = await get('tenant', '/v1/tenant/volumes') as Array<{ name: string }>
    const leftOver = [...vms, ...volumes, ...networks.filter((n) => !n.name.startsWith(RUN_NETWORK_PREFIX))]
      .map((r) => r.name).filter((name) => name.startsWith('rg-'))
    log(`SMOKE-05 networks=[${networks.map((n) => n.name).join(',')}] vms=${vms.length} volumes=${volumes.length} leftOver=[${leftOver.join(',')}]`)
    expect(leftOver).toEqual([])
    const otherNetworks = networks.filter((n) => !n.name.startsWith(RUN_NETWORK_PREFIX))
    expect(otherNetworks.length, 'networks that are not the run network').toBeLessThan(tenant.maxNetworks)
  })
})
