import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, get, log, startLog } from './api'
import { envOf } from './fixtures'

// Case ADM-10 of plan.md. Read only: the PUT and DELETE it sends must change nothing.
test.describe.serial('admin clusters', () => {
  test.beforeAll(async ({ browser }) => {
    startLog('admin-clusters')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  // titan-ops features/cluster/design.md#cluster-admin-routes ·
  // OpenViCloud/titan-control-plane:Titan.Application/Abstractions/IAdminClusterService.cs (AdminClusterDto, AdminClusterProviderSettingsDto) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/ListAdminClustersEndpoint.cs (Configure: Get("v1/admin/clusters")) — no PUT or DELETE route
  test('ADM-10 the admin cluster list is the config, and PUT or DELETE of a cluster changes nothing', async () => {
    const { clusterId } = await envOf()
    const before = await get('admin', '/v1/admin/clusters') as any[]
    log(`ADM-10 clusters=${JSON.stringify(before)}`)
    expect(before.length).toBeGreaterThan(0)
    const mine = before.find((c) => c.clusterId === clusterId)
    expect(mine, `cluster ${clusterId} of /v1/clusters is in the admin list`).toBeTruthy()
    for (const c of before) {
      expect(Object.keys(c).sort()).toEqual(['clusterId', 'endpoint', 'name', 'providerSettings', 'serverFingerprint'])
      expect(c.serverFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(Object.keys(c.providerSettings).sort()).toEqual(['ipv6Block', 'ovnUplinkNetwork', 'storagePool'])
    }

    const body = { name: mine.name, endpoint: mine.endpoint, serverFingerprint: mine.serverFingerprint, providerSettings: mine.providerSettings }
    const put = await call('admin', 'PUT', `/v1/admin/clusters/${clusterId}`, body)
    const del = await call('admin', 'DELETE', `/v1/admin/clusters/${clusterId}`, body)
    log(`ADM-10 PUT=${put.status} DELETE=${del.status}`)
    expect(put.status < 200 || put.status > 299, `PUT answered ${put.status}`).toBe(true)
    expect(del.status < 200 || del.status > 299, `DELETE answered ${del.status}`).toBe(true)
    expect(await get('admin', '/v1/admin/clusters')).toEqual(before)
  })
})
