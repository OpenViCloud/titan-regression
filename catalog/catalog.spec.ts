import { test, expect } from '@playwright/test'
import { closeSessions, headersOf, useBrowser } from './auth'
import { call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { activityOf, envOf, RUN } from './fixtures'
import { cleanUp } from './clean-up'

// Cases CAT-01..08, CAT-10, CAT-12, CAT-13 and CAT-15 of plan.md (CAT-09 and CAT-16 read the Incus host: Phase 4 of
// release:regression-prd; CAT-11 and CAT-14 are not covered).

// The row of one template in one cluster, from GET /v1/admin/templates.
function clusterRowOf(template: any, clusterId: string): any {
  return template.clusters.find((z: any) => z.clusterId === clusterId)
}

function everyRowAtRest(rows: any[]): boolean {
  return rows.every((r) => r.clusters.every((z: any) => z.status !== 'Syncing'))
}

function restShape(rows: any[]): string {
  return rows.map((r) => r.clusters.map((z: any) => `${r.name}@${z.clusterId}=${z.status}`).join(' ')).join(' ')
}

// Ordinal, like StringComparer.Ordinal: JavaScript compares strings by UTF-16 code unit, as .NET's ordinal does.
function sortedOrdinal(names: string[]): string[] {
  return names.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
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
    // Every template the customer sees for the cluster Exists there (titan-ops features/catalog/design.md#template-per-cluster).
    const admin = await get('admin', '/v1/admin/templates') as any[]
    for (const template of templates) {
      const row = admin.find((a) => a.id === template.id)
      const cluster = row.clusters.find((z: any) => z.clusterId === clusterId)
      expect(cluster.status, `${template.name} in ${clusterId}`).toBe('Available')
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

  // OpenViCloud/titan-control-plane:Titan.Application/Options/ClusterOptions.cs ClusterOf (CLUSTER_NOT_FOUND)
  test('CAT-03 an unknown cluster is 404 CLUSTER_NOT_FOUND', async () => {
    expectError(await call('tenant', 'GET', '/v1/templates?clusterId=rg-no-such-cluster'), 404, 'CLUSTER_NOT_FOUND')
  })

  // titan-ops features/catalog/design.md#template-per-cluster · titan-ops features/catalog/design.md#template-customer-read ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmTemplate/ListTemplatesQueryHandler.cs (HandleAsync: ListSyncedInAnyClusterAsync
  // without a cluster; OrderBy Name with StringComparer.Ordinal for both lists) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/ListTemplatesEndpoint.cs (Configure: no AllowAnonymous ⇒ 401 without a token)
  test('CAT-04 without a cluster, every template listed Exists in at least one cluster; both lists ordered by name; no token is 401', async () => {
    const { clusterId } = await envOf()
    const templates = await get('tenant', '/v1/templates') as any[]
    const admin = await get('admin', '/v1/admin/templates') as any[]
    for (const template of templates) {
      const row = admin.find((a) => a.id === template.id)
      const somewhere = row.clusters.some((z: any) => z.status === 'Available')
      expect(somewhere, template.name).toBe(true)
    }
    const ofCluster = await get('tenant', `/v1/templates?clusterId=${clusterId}`) as any[]
    for (const [path, list] of [['/v1/templates', templates], [`/v1/templates?clusterId=${clusterId}`, ofCluster]] as Array<[string, any[]]>) {
      const names = list.map((t) => t.name as string)
      log(`CAT-04 ${path}: ${JSON.stringify(names)}`)
      expect(names, `${path} ordered by name, ordinal`).toEqual(sortedOrdinal(names))
    }
    const anonymous = await call('anonymous', 'GET', '/v1/templates')
    log(`CAT-04 no token: ${anonymous.status}`)
    expectStatus(anonymous, 401)
  })

  // titan-ops features/catalog/design.md#cluster-is-a-real-choice ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/CreateNetworkCommandHandler.cs (HandleAsync: ClusterOf before the quota and
  // before activity.Stage) · OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/CreateVolumeCommandHandler.cs (HandleAsync: the volume
  // quota first, then ClusterOf, before activity.Stage) · OpenViCloud/titan-control-plane:Titan.Application/Options/ClusterOptions.cs (ClusterOf: CLUSTER_NOT_FOUND)
  test('CAT-15 a network or a volume in an unknown cluster is 404 CLUSTER_NOT_FOUND and leaves nothing', async () => {
    const { volumeOfferingId } = await envOf()
    const networkName = `rg-net-${RUN}-nc`
    const volumeName = `rg-vol-${RUN}-nc`
    try {
      // The volume handler checks the quota before the cluster: with no room the answer is the quota's, not this case.
      const tenant = await get('tenant', '/v1/tenant')
      const volumes = await get('tenant', '/v1/tenant/volumes') as any[]
      log(`CAT-15 volumes=${volumes.length} maxVolumes=${tenant.maxVolumes}`)
      expect(volumes.length, 'room for one volume in maxVolumes (the quota is checked before the cluster)').toBeLessThan(tenant.maxVolumes)

      const network = await call('tenant', 'POST', '/v1/tenant/networks', { name: networkName, clusterId: 'khong-co' }, newKey())
      log(`CAT-15 network: ${network.status} ${network.text.slice(0, 300)}`)
      expectError(network, 404, 'CLUSTER_NOT_FOUND')
      const volume = await call('tenant', 'POST', '/v1/tenant/volumes',
        { name: volumeName, clusterId: 'khong-co', volumeOfferingId, sizeGb: 1 }, newKey())
      log(`CAT-15 volume: ${volume.status} ${volume.text.slice(0, 300)}`)
      expectError(volume, 404, 'CLUSTER_NOT_FOUND')

      const networkNames = (await get('tenant', '/v1/tenant/networks') as any[]).map((n) => n.name)
      const volumeNames = (await get('tenant', '/v1/tenant/volumes') as any[]).map((v) => v.name)
      expect(networkNames).not.toContain(networkName)
      expect(volumeNames).not.toContain(volumeName)
      const networkActions = await activityOf(networkName)
      const volumeActions = await activityOf(volumeName)
      log(`CAT-15 feed network=${JSON.stringify(networkActions)} volume=${JSON.stringify(volumeActions)}`)
      expect(networkActions).not.toContain('network.create_requested')
      expect(volumeActions).not.toContain('volume.create_requested')
    } finally {
      // Only a refusal that did not hold would leave these; the network would also pass for the run's network (rg-net-).
      await cleanUp([
        ['network', async () => {
          for (const n of (await get('tenant', '/v1/tenant/networks') as any[]).filter((x) => x.name === networkName)) {
            await call('tenant', 'DELETE', `/v1/tenant/networks/${n.id}`)
          }
        }],
        ['volume', async () => {
          for (const v of (await get('tenant', '/v1/tenant/volumes') as any[]).filter((x) => x.name === volumeName)) {
            await call('tenant', 'DELETE', `/v1/tenant/volumes/${v.id}`)
          }
        }],
      ])
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
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmTemplate/SyncTemplatesCommandHandler.cs HandleAsync (VmTemplate.NeedsSyncIn, SyncIn)
  // a template with no image for the cluster architecture gives up (titan-ops features/catalog/design.md#template-architecture)
  test('CAT-06 sync: every template ends Exists or gives up in the cluster, none stays Syncing', async () => {
    const { clusterId } = await envOf()
    const reply = await call('admin', 'POST', '/v1/admin/templates/sync')
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    const settled = await pollUntil('CAT-06 sync', () => get('admin', '/v1/admin/templates') as Promise<any[]>,
      (rows) => rows.every((r) => r.clusters.find((z: any) => z.clusterId === clusterId).status !== 'Syncing'),
      (rows) => rows.map((r) => {
        const z = r.clusters.find((x: any) => x.clusterId === clusterId)
        return `${r.name}=${z.status}/${z.requestFailureReason}`
      }).join(' '))
    for (const row of settled) {
      const cluster = row.clusters.find((z: any) => z.clusterId === clusterId)
      const done = cluster.status === 'Available' || cluster.requestFailureReason !== null
      expect(done, `${row.name} in ${clusterId}`).toBe(true)
    }
    expect(settled.some((r) => r.clusters.find((z: any) => z.clusterId === clusterId).status === 'Available')).toBe(true)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmTemplate/SyncTemplatesCommandHandler.cs HandleAsync (VmTemplate.NeedsSyncIn) — a cluster that has the alias asks for nothing
  test('CAT-07 a second sync leaves the templates that Exist as they are', async () => {
    const { clusterId } = await envOf()
    const before = (await get('admin', '/v1/admin/templates') as any[])
      .filter((r) => r.clusters.find((z: any) => z.clusterId === clusterId).status === 'Available').map((r) => r.id)
    expectStatus(await call('admin', 'POST', '/v1/admin/templates/sync'), 202)
    const after = await pollUntil('CAT-07 second sync', () => get('admin', '/v1/admin/templates') as Promise<any[]>,
      (rows) => rows.every((r) => r.clusters.find((z: any) => z.clusterId === clusterId).status !== 'Syncing'),
      (rows) => rows.map((r) => `${r.name}=${r.clusters.find((z: any) => z.clusterId === clusterId).status}`).join(' '))
    for (const id of before) {
      const cluster = after.find((r) => r.id === id).clusters.find((z: any) => z.clusterId === clusterId)
      expect(cluster.status, id).toBe('Available')
    }
  })

  // titan-ops architecture/resource-lifecycle.md#one-key-per-request · titan-ops features/catalog/design.md#template-sync-add-only ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmTemplate/SyncTemplatesCommandHandler.cs (HandleAsync: each template locked in id
  // order and read again under the lock) · OpenViCloud/titan-control-plane:Titan.Tests/Infrastructure/Integration/TemplateRequestsDbTests.cs
  // (TwoSyncAlls_AtOnce_LeaveOneRequest_AndOneCommandRow_PerTemplatePerCluster) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/PendingRequestReader.cs
  // (ListStuckAsync: resource 'template' for a template's sync)
  test('CAT-12 two syncs sent at once are both 202, every template comes to rest, none stuck', async () => {
    // One sign-in before the two calls, so they do not race to sign in.
    await headersOf('admin')
    const [first, second] = await Promise.all([
      call('admin', 'POST', '/v1/admin/templates/sync'),
      call('admin', 'POST', '/v1/admin/templates/sync'),
    ])
    log(`CAT-12 replies ${first.status} "${first.text.slice(0, 200)}" ${second.status} "${second.text.slice(0, 200)}"`)
    for (const reply of [first, second]) {
      expectStatus(reply, 202)
      expect(reply.text).toBe('')
    }
    await pollUntil('CAT-12 every (template, cluster) at rest', () => get('admin', '/v1/admin/templates') as Promise<any[]>,
      everyRowAtRest, restShape)
    const stuck = await get('admin', '/v1/admin/requests/stuck') as any[]
    log(`CAT-12 stuck: ${JSON.stringify(stuck).slice(0, 500)}`)
    expect(stuck.filter((r) => r.resource === 'template')).toEqual([])
  })

  // titan-ops architecture/resource-lifecycle.md#repeat · titan-ops features/catalog/design.md#template-sync-add-only ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Catalog/VmTemplate/SyncTemplatesCommandHandler.cs (VmTemplate.NeedsSyncIn: a cluster whose sync
  // waits gets nothing) · OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmTemplate/Contracts/AdminTemplateClusterQueryResult.cs
  // (Transition, RequestFailedAt)
  test('CAT-13 a second sync while a template is still Syncing sends nothing more: it comes to rest once', async () => {
    const { clusterId } = await envOf()
    const before = await get('admin', '/v1/admin/templates') as any[]
    const notThere = before.filter((r) => clusterRowOf(r, clusterId).status !== 'Available').map((r) => r.id as string)
    log(`CAT-13 not Available in ${clusterId}: ${JSON.stringify(before.filter((r) => notThere.includes(r.id)).map((r) => r.name))}`)
    test.skip(notThere.length === 0, `every template Available in ${clusterId}: no sync is left to wait (amd64 syncs all three)`)

    expectStatus(await call('admin', 'POST', '/v1/admin/templates/sync'), 202)
    const afterFirst = await get('admin', '/v1/admin/templates') as any[]
    const syncing = afterFirst.filter((r) => notThere.includes(r.id) && clusterRowOf(r, clusterId).status === 'Syncing')
      .map((r) => r.id as string)
    log(`CAT-13 Syncing after the first POST: ${JSON.stringify(afterFirst.filter((r) => syncing.includes(r.id)).map((r) => r.name))}`)
    test.skip(syncing.length === 0, 'the sync came to rest before the second POST could be sent')

    const second = await call('admin', 'POST', '/v1/admin/templates/sync')
    expectStatus(second, 202)
    expect(second.text).toBe('')

    // Each row's transitions and give-up times, read every 2 s from the second POST until 60 s after the last row rests:
    // one request means Syncing … then at rest, never Syncing again, and at most one new requestFailedAt. A "transition"
    // here is just the cluster's status while it is Syncing, else null (at rest).
    const transitionOf = (row: any): string | null => (row.status === 'Syncing' ? 'Syncing' : null)
    const seen: Record<string, { transitions: Array<string | null>, failedAt: Set<string> }> = {}
    for (const id of syncing) {
      const row = clusterRowOf(before.find((r) => r.id === id), clusterId)
      seen[id] = { transitions: [], failedAt: new Set(row.requestFailedAt === null ? [] : [row.requestFailedAt]) }
    }
    const started = Date.now()
    let restedAt: number | null = null
    while (restedAt === null || Date.now() - restedAt < 60_000) {
      const rows = await get('admin', '/v1/admin/templates') as any[]
      for (const id of syncing) {
        const row = clusterRowOf(rows.find((r) => r.id === id), clusterId)
        const transitions = seen[id].transitions
        const transition = transitionOf(row)
        if (transitions.length === 0 || transitions[transitions.length - 1] !== transition) {
          transitions.push(transition)
          log(`CAT-13 ${rows.find((r) => r.id === id).name}: ${row.status} failedAt=${row.requestFailedAt} reason=${row.requestFailureReason} (+${Math.round((Date.now() - started) / 1000)}s)`)
        }
        if (row.requestFailedAt !== null) {
          seen[id].failedAt.add(row.requestFailedAt)
        }
      }
      const allAtRest = syncing.every((id) => seen[id].transitions[seen[id].transitions.length - 1] === null)
      if (allAtRest && restedAt === null) {
        restedAt = Date.now()
      }
      if (!allAtRest) {
        restedAt = null
      }
      if (Date.now() - started > 6 * 60_000) {
        throw new Error('CAT-13: the Syncing rows did not come to rest within 6 minutes')
      }
      await sleep(2_000)
    }
    for (const id of syncing) {
      const { transitions, failedAt } = seen[id]
      const name = before.find((r) => r.id === id).name
      log(`CAT-13 ${name} transitions=${JSON.stringify(transitions)} failedAt=${JSON.stringify([...failedAt])}`)
      // Still Syncing right after the second POST, or already at rest; never back to Syncing once at rest.
      expect(transitions.filter((t) => t === null).length, `${name} comes to rest once`).toBe(1)
      expect(transitions[transitions.length - 1], name).toBeNull()
      // The give-up time from before the first POST (if any) and at most one new one.
      const beforeRow = clusterRowOf(before.find((r) => r.id === id), clusterId)
      const newGiveUps = [...failedAt].filter((t) => t !== beforeRow.requestFailedAt)
      expect(newGiveUps.length, `${name} gives up at most once`).toBeLessThanOrEqual(1)
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
        expect(['Syncing', 'Available', 'NotFound', 'Failed']).toContain(cluster.status)
      }
    }
    log(`CAT-08 ${rows.map((r) => `${r.name}→${r.vmOfferingId}`).join(' ')}`)
  })
})
