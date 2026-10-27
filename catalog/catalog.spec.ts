import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, expectError, expectStatus, get, log, pollUntil, startLog } from './api'
import { envOf } from './fixtures'

// Cases CAT-01..08 and CAT-10 of plan.md (CAT-09 reads the Incus host: Phase 4 of release:regression).
test.describe.serial('catalog', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  test.beforeAll(async ({ browser }) => {
    startLog('catalog')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmOffering/Contracts/VmOfferingQueryResult.cs (VmOfferingQueryResult)
  test('CAT-01 vm offerings carry sizing and a price', async () => {
    const offerings = await get('anonymous', '/v1/vm-offerings') as any[]
    log(`CAT-01 tiers ${offerings.map((o) => `${o.id}:${o.vcpu}vcpu/${o.memoryMb}MB/${o.pricePerHour}`).join(' ')}`)
    expect(offerings.map((o) => o.id).sort()).toEqual(['l', 'm', 's', 'xl'])
    for (const offering of offerings) {
      expect(offering.vcpu, offering.id).toBeGreaterThan(0)
      expect(offering.memoryMb, offering.id).toBeGreaterThan(0)
      expect(offering.cpu, offering.id).toBeGreaterThan(0)
      expect(offering.pricePerHour, offering.id).toBeGreaterThan(0)
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmTemplate/Contracts/TemplateQueryResult.cs (TemplateQueryResult)
  test('CAT-02 templates of a cluster carry no sizing and no offering', async () => {
    const { clusterId } = await envOf()
    const templates = await get('tenant', `/v1/templates?clusterId=${clusterId}`) as any[]
    log(`CAT-02 ${clusterId}: ${templates.map((t) => t.name).join(', ')}`)
    expect(templates.length).toBeGreaterThan(0)
    for (const template of templates) {
      expect(Object.keys(template).sort()).toEqual(['description', 'diskGb', 'id', 'name', 'os'])
    }
    // Every template the customer sees for the cluster Exists there (OpenViCloud/titan-ops:docs/features/catalog/design.md#template-per-cluster).
    const admin = await get('admin', '/v1/admin/templates') as any[]
    for (const template of templates) {
      const row = admin.find((a) => a.id === template.id)
      const cluster = row.clusters.find((z: any) => z.clusterId === clusterId)
      expect(cluster.currentExistence, `${template.name} in ${clusterId}`).toBe('Exists')
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmTemplate/ListTemplatesQueryHandler.cs HandleAsync (customers: IsListed only) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmTemplate/Contracts/AdminTemplateQueryResult.cs AdminTemplateQueryResult.Listed (admin: every template, flagged)
  test('CAT-10 an unlisted template reaches no customer list; admin sees it flagged', async () => {
    const admin = await get('admin', '/v1/admin/templates') as any[]
    const unlisted = admin.filter((a) => a.listed === false).map((a) => a.id)
    log(`CAT-10 admin: ${admin.map((a) => `${a.name}:${a.listed}`).join(' ')}`)
    expect(admin.every((a) => typeof a.listed === 'boolean'), 'every admin row carries listed').toBe(true)
    test.skip(unlisted.length === 0, 'no unlisted template on this env')
    const { clusterId } = await envOf()
    for (const path of ['/v1/templates', `/v1/templates?clusterId=${clusterId}`]) {
      const customer = await get('tenant', path) as any[]
      log(`CAT-10 ${path}: ${customer.map((t) => t.name).join(', ')}`)
      expect(customer.length, path).toBeGreaterThan(0)
      for (const template of customer) {
        expect(unlisted, `${path} lists ${template.name}`).not.toContain(template.id)
      }
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Options/ClusterOptions.cs Require (CLUSTER_NOT_FOUND)
  test('CAT-03 an unknown cluster is 404 CLUSTER_NOT_FOUND', async () => {
    expectError(await call('tenant', 'GET', '/v1/templates?clusterId=rg-no-such-cluster'), 404, 'CLUSTER_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmTemplate/ListTemplatesQueryHandler.cs HandleAsync (ListSyncedInAnyClusterAsync) — no cluster ⇒ synced in any cluster
  test('CAT-04 without a cluster, every template listed Exists in at least one cluster', async () => {
    const templates = await get('tenant', '/v1/templates') as any[]
    const admin = await get('admin', '/v1/admin/templates') as any[]
    for (const template of templates) {
      const row = admin.find((a) => a.id === template.id)
      const somewhere = row.clusters.some((z: any) => z.currentExistence === 'Exists')
      expect(somewhere, template.name).toBe(true)
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/ListClustersEndpoint.cs (Configure: Get("v1/clusters"), AllowAnonymous),
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/ListOsImagesEndpoint.cs (Configure: Get("v1/os-images"), AllowAnonymous)
  test('CAT-05 the configured clusters, and OS images read live from Incus', async () => {
    const { clusterId } = await envOf()
    const clusters = await get('anonymous', '/v1/clusters') as Array<{ id: string, name: string }>
    log(`CAT-05 clusters: ${JSON.stringify(clusters).slice(0, 300)}`)
    expect(clusters.map((c) => c.id)).toContain(clusterId)
    for (const cluster of clusters) {
      expect(Object.keys(cluster).sort()).toEqual(['id', 'name'])
    }
    const images = await get('anonymous', '/v1/os-images') as any[]
    log(`CAT-05 os images: ${images.length}`)
    expect(images.length).toBeGreaterThan(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/SyncTemplatesEndpoint.cs HandleAsync (202);
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmTemplate/SyncTemplatesCommandHandler.cs HandleAsync (NeedsASyncRequest, RequestSyncIn)
  // a template with no image for the cluster architecture gives up (OpenViCloud/titan-ops:docs/features/catalog/design.md#template-architecture)
  test('CAT-06 sync: every template ends Exists or gives up in the cluster, none stays Syncing', async () => {
    const { clusterId } = await envOf()
    const reply = await call('admin', 'POST', '/v1/admin/templates/sync')
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    const settled = await pollUntil('CAT-06 sync', () => get('admin', '/v1/admin/templates') as Promise<any[]>,
      (rows) => rows.every((r) => r.clusters.find((z: any) => z.clusterId === clusterId).transition === null),
      (rows) => rows.map((r) => {
        const z = r.clusters.find((x: any) => x.clusterId === clusterId)
        return `${r.name}=${z.currentExistence}/${z.transition}/${z.requestFailureReason}`
      }).join(' '))
    for (const row of settled) {
      const cluster = row.clusters.find((z: any) => z.clusterId === clusterId)
      const done = cluster.currentExistence === 'Exists' || cluster.requestFailureReason !== null
      expect(done, `${row.name} in ${clusterId}`).toBe(true)
    }
    expect(settled.some((r) => r.clusters.find((z: any) => z.clusterId === clusterId).currentExistence === 'Exists')).toBe(true)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmTemplate/SyncTemplatesCommandHandler.cs HandleAsync (NeedsASyncRequest) — a cluster whose cluster has the alias asks for nothing
  test('CAT-07 a second sync leaves the templates that Exist as they are', async () => {
    const { clusterId } = await envOf()
    const before = (await get('admin', '/v1/admin/templates') as any[])
      .filter((r) => r.clusters.find((z: any) => z.clusterId === clusterId).currentExistence === 'Exists').map((r) => r.id)
    expectStatus(await call('admin', 'POST', '/v1/admin/templates/sync'), 202)
    const after = await pollUntil('CAT-07 second sync', () => get('admin', '/v1/admin/templates') as Promise<any[]>,
      (rows) => rows.every((r) => r.clusters.find((z: any) => z.clusterId === clusterId).transition === null),
      (rows) => rows.map((r) => `${r.name}=${r.clusters.find((z: any) => z.clusterId === clusterId).currentExistence}`).join(' '))
    for (const id of before) {
      const cluster = after.find((r) => r.id === id).clusters.find((z: any) => z.clusterId === clusterId)
      expect(cluster.currentExistence, id).toBe('Exists')
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmTemplate/Contracts/AdminTemplateQueryResult.cs (AdminTemplateQueryResult)
  test('CAT-08 the admin template list carries vmOfferingId and existence per cluster', async () => {
    const rows = await get('admin', '/v1/admin/templates') as any[]
    const tiers = (await get('anonymous', '/v1/vm-offerings') as any[]).map((o) => o.id)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(tiers, `${row.name} borrows a real tier`).toContain(row.vmOfferingId)
      expect(row.clusters.length, row.name).toBeGreaterThan(0)
      for (const cluster of row.clusters) {
        expect(['NotCreated', 'Exists', 'NotFound']).toContain(cluster.currentExistence)
      }
    }
    log(`CAT-08 ${rows.map((r) => `${r.name}→${r.vmOfferingId}`).join(' ')}`)
  })
})
