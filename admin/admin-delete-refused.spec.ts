import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { cleanUp } from './clean-up'
import { RUN, createVm, deleteVmAndWait, envOf, existenceShape, getVm, networkUsable, runNetwork, runs, vmShape, waitNetwork, waitVm } from './fixtures'

// Cases ADM-12, ADM-13 of plan.md: the admin delete of a tenant's VM is refused by the same rules as the tenant's own
// (VMS-05, LB-05), and a refusal writes no audit row. ADM-12 uses a VM on the run network; ADM-13 raises maxNetworks by
// one for a network with public IPv6 (a load balancer needs one), gives it back in afterAll, and is skipped in a cluster
// that names no IPv6 block.
test.describe.serial('admin-delete-refused', () => {
  test.describe.configure({ timeout: 20 * 60_000 })

  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null
  let snapshotVmId = ''
  let snapshotId = ''
  let ipv6NetworkId = ''
  let backendVmId = ''
  let lbId = ''

  const http = { protocol: 'TCP', port: 80, targetPort: 8080 }

  function snapshotShape(s: any): string {
    return `status=${s.status} failure=${s.requestFailureReason}`
  }

  // VmSnapshotStatus: Creating, Reverting, Deleting are in flight; everything else (Available, NotFound, Failed,
  // Deleted) is at rest.
  function snapshotAtRest(s: any): boolean {
    return s.status !== 'Creating' && s.status !== 'Reverting' && s.status !== 'Deleting'
  }

  // The list leaves Deleted snapshots out (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmSnapshotRepository.cs FindByVmIdAsync).
  async function readSnapshot(vmId: string, id: string): Promise<any> {
    const reply = await call('tenant', 'GET', `/v1/tenant/vms/${vmId}/snapshots`)
    if (reply.status === 404) {
      return { status: 'Deleted' }
    }
    expectStatus(reply, 200)
    const row = (bodyOf(reply) as any[]).find((s) => s.id === id)
    if (row === undefined) {
      return { status: 'Deleted' }
    }
    return row
  }

  const readLb = (id: string) => get('tenant', `/v1/tenant/load-balancers/${id}`)

  // Every audit row of a cross-tenant delete of this VM (the list is newest first; 200 is its cap).
  async function crossTenantDeletesOf(vmId: string): Promise<any[]> {
    const rows = await get('admin', '/v1/admin/audit-log?limit=200') as any[]
    return rows.filter((r) => r.resourceId === vmId && r.action === 'vm.delete.cross_tenant')
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('admin-delete-refused')
    useBrowser(browser)
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    originalQuota = { maxVms: tenant.maxVms, maxNetworks: tenant.maxNetworks }
    log(`quota before: ${JSON.stringify(originalQuota)}`)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    await cleanUp([
      ['snapshot at rest', async () => {
        if (snapshotId !== '') {
          await pollUntil('snapshot at rest', () => readSnapshot(snapshotVmId, snapshotId), snapshotAtRest, snapshotShape)
        }
      }],
      ['vm with a snapshot', async () => {
        if (snapshotVmId !== '') {
          await deleteVmAndWait(snapshotVmId)
        }
      }],
      ['load balancer', async () => {
        if (lbId === '') {
          return
        }
        const lb = await readLb(lbId)
        if (lb.status !== 'Deleting' && lb.status !== 'Deleted') {
          // LoadBalancerStatus: Creating, Updating, Deleting are in flight; Available is the resting status.
          await pollUntil('load balancer at rest', () => readLb(lbId), (row) => row.status !== 'Creating' && row.status !== 'Updating' && row.status !== 'Deleting', existenceShape)
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lbId}`), 202)
        }
        await pollUntil('load balancer deleted', () => readLb(lbId), (row) => row.status === 'Deleted', existenceShape)
      }],
      ['backend vm', async () => {
        if (backendVmId !== '') {
          await deleteVmAndWait(backendVmId)
        }
      }],
      ['IPv6 network', async () => {
        if (ipv6NetworkId === '') {
          return
        }
        const network = await get('tenant', `/v1/tenant/networks/${ipv6NetworkId}`)
        if (network.status !== 'Deleting' && network.status !== 'Deleted') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${ipv6NetworkId}`), 202)
        }
        await waitNetwork('IPv6 network deleted', ipv6NetworkId, (n) => n.status === 'Deleted')
      }],
      ['quota', async () => {
        if (originalQuota !== null) {
          expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
        }
      }],
      ['sessions', closeSessions],
    ])
  })

  // titan-ops features/vm/design.md#vm-snapshot · titan-ops features/vm/design.md#admin-delete-audit ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Vm/DeleteAdminVmCommandHandler.cs (HandleAsync: deletion.DeleteAsync before
  // auditLog.Add) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Deletion.cs (Delete: EnsureNotInTransition ⇒ VM_INVALID_STATUS) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Snapshots.cs (AddSnapshot, RevertSnapshot: Status = Snapshotting) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/ErrorStatus.cs (BusinessException ⇒ 422)
  test('ADM-12 admin delete of a VM whose snapshot is being made is 422 VM_INVALID_STATUS; the VM stays, no audit row', async () => {
    const network = await runNetwork()
    const { smallTier } = await envOf()
    snapshotVmId = await createVm(`rg-admsnapvm-${RUN}`, smallTier, network.id)
    await waitVm('ADM-12 vm running', snapshotVmId, (v) => runs(v))

    // The window is from the 202 to the worker's report (lease poll 2 s plus Incus's snapshot): the delete goes
    // right after one read of the snapshot. The admin session is opened first, so its sign-in does not eat the
    // window; a snapshot already at rest at that read is a lap the race lost, not a measure of the rule.
    await get('admin', '/v1/admin/clusters')
    const created = await call('tenant', 'POST', `/v1/tenant/vms/${snapshotVmId}/snapshots`, { name: `rg-admsnap-${RUN}` }, newKey())
    expectStatus(created, 202)
    snapshotId = bodyOf(created).snapshotId
    const before = await readSnapshot(snapshotVmId, snapshotId)
    log(`ADM-12 snapshot before the delete: ${snapshotShape(before)}`)
    test.skip(snapshotAtRest(before), 'ADM-12: the snapshot came to rest before the admin delete; the race window was missed')
    const refused = await call('admin', 'DELETE', `/v1/admin/vms/${snapshotVmId}`)
    log(`ADM-12 admin delete: ${refused.status} ${refused.text.slice(0, 300)}`)
    expectError(refused, 422, 'VM_INVALID_STATUS')

    const vm = await getVm(snapshotVmId)
    log(`ADM-12 vm after: ${vmShape(vm)}`)
    expect(['Deleting', 'Deleted']).not.toContain(vm.status)
    // The refused delete leaves the VM on the snapshot's wait or at rest; it never starts a request of its own.
    expect(['Creating', 'Starting', 'Stopping']).not.toContain(vm.status)
    expect(await crossTenantDeletesOf(snapshotVmId)).toEqual([])
    await pollUntil('ADM-12 snapshot settles', () => readSnapshot(snapshotVmId, snapshotId), snapshotAtRest, snapshotShape)
  })

  // titan-ops features/vm/design.md#admin-delete-audit · titan-ops features/load-balancer/design.md#lb-and-vm-network ·
  // titan-ops architecture/domain-services.md#domain-service · OpenViCloud/titan-control-plane:Titan.Domain/Services/VmDeletion.cs (DeleteAsync:
  // IsBackendAsync ⇒ VM_IS_LOAD_BALANCER_BACKEND, thrown before anything is saved) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/LoadBalancerRepository.cs
  // (IsBackendAsync: any load balancer not current Deleted, its create still waiting included) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Vm/DeleteAdminVmCommandHandler.cs (HandleAsync: deletion.DeleteAsync before auditLog.Add)
  test('ADM-13 admin delete of a load balancer backend VM is 422 VM_IS_LOAD_BALANCER_BACKEND; the VM stays, no audit row', async () => {
    const { clusterId, smallTier } = await envOf()
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    const block = clusters.find((c) => c.clusterId === clusterId)?.providerSettings?.ipv6Block ?? null
    log(`ADM-13 cluster=${clusterId} ipv6Block=${block}`)
    test.skip(!block, 'the cluster has no IPv6 block')

    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`,
      { maxVms: originalQuota!.maxVms, maxNetworks: originalQuota!.maxNetworks + 1 }), 204)
    const network = await call('tenant', 'POST', '/v1/tenant/networks', { name: `rg-admnet6-${RUN}`, clusterId, enablePublicIpv6: true }, newKey())
    expectStatus(network, 202)
    ipv6NetworkId = bodyOf(network).networkId
    await waitNetwork('ADM-13 IPv6 network usable', ipv6NetworkId, networkUsable)
    backendVmId = await createVm(`rg-admlbvm-${RUN}`, smallTier, ipv6NetworkId)
    await waitVm('ADM-13 backend vm on Incus', backendVmId, (v) => runs(v))
    const created = await call('tenant', 'POST', '/v1/tenant/load-balancers',
      { name: `rg-admlb-${RUN}`, networkId: ipv6NetworkId, listeners: [http], backends: [{ vmId: backendVmId }] }, newKey())
    expectStatus(created, 202)
    lbId = bodyOf(created).loadBalancerId
    const lb = await readLb(lbId)
    log(`ADM-13 load balancer: ${existenceShape(lb)}`)
    expect(['Deleting', 'Deleted']).not.toContain(lb.status)

    const refused = await call('admin', 'DELETE', `/v1/admin/vms/${backendVmId}`)
    log(`ADM-13 admin delete: ${refused.status} ${refused.text.slice(0, 300)}`)
    expectError(refused, 422, 'VM_IS_LOAD_BALANCER_BACKEND')
    const vm = await getVm(backendVmId)
    log(`ADM-13 vm after: ${vmShape(vm)}`)
    expect(['Deleting', 'Deleted']).not.toContain(vm.status)
    expect(await crossTenantDeletesOf(backendVmId)).toEqual([])
  })
})
