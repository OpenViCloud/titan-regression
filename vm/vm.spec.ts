import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, startLog } from './api'
import { cleanUp } from './clean-up'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, waitVm } from './fixtures'

// Cases VM-01..19, VM-21 and VM-22 of plan.md, plus ACT-01/ACT-03 for VMs. VM-14 is NOT COVERED, VM-20 reads
// the Incus host. Create checks run in this order
// (OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync): quota inside Vm.Create, cluster,
// name, network, offering, template — so the error cases run below the quota.
test.describe.serial('vm', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  const nameA = `rg-vma-${RUN}`
  const nameB = `rg-vmb-${RUN}`
  const renamed = `rg-vma-${RUN}-renamed`
  let networkId = ''
  let tenantId = ''
  let originalQuota: { maxVms: number, maxNetworks: number } | null = null
  const made: string[] = []
  let vmA = ''
  let vmB = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('vm')
    useBrowser(browser)
    networkId = (await runNetwork()).id
    const tenant = await get('tenant', '/v1/tenant')
    tenantId = tenant.id
    originalQuota = { maxVms: tenant.maxVms, maxNetworks: tenant.maxNetworks }
    log(`quota before: ${JSON.stringify(originalQuota)}`)
  })

  test.afterAll(async () => {
    test.setTimeout(20 * 60_000)
    const steps: Array<[string, () => Promise<void>]> = [
      ['quota', async () => {
        if (originalQuota !== null) {
          expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
        }
      }],
    ]
    for (const id of made) {
      steps.push([`vm ${id}`, () => deleteVmAndWait(id)])
    }
    steps.push(['sessions', closeSessions])
    await cleanUp(steps)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmValidator.cs CreateVmValidator (Name MaximumLength(64))
  test('VM-09 a 65-character name is 400 VALIDATION_ERROR', async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: 'rg-' + 'x'.repeat(62), networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()),
      400, 'VALIDATION_ERROR')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync: clusters.Require
  // (OpenViCloud/titan-control-plane:Titan.Application/Options/ClusterOptions.cs Require), VM_OFFERING_NOT_FOUND, TEMPLATE_NOT_FOUND
  test('VM-11 unknown offering, template, cluster are 404 with their codes', async () => {
    const { clusterId, templateId, smallTier } = await envOf()
    const base = { name: `rg-vmx-${RUN}`, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', { ...base, vmOfferingId: 'rg-none' }, newKey()), 404, 'VM_OFFERING_NOT_FOUND')
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', { ...base, templateId: randomUUID() }, newKey()), 404, 'TEMPLATE_NOT_FOUND')
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', { ...base, clusterId: 'rg-no-such-cluster' }, newKey()), 404, 'CLUSTER_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync (!template.IsListed ⇒ TEMPLATE_NOT_FOUND) — not listed ⇒ as if it did not exist
  test('VM-22 a template customers are not offered is 404 TEMPLATE_NOT_FOUND, and no VM is made', async () => {
    const admin = await get('admin', '/v1/admin/templates') as any[]
    const unlisted = admin.find((a) => a.listed === false)
    test.skip(unlisted === undefined, 'no unlisted template on this env')
    const { clusterId, smallTier } = await envOf()
    const name = `rg-vmu-${RUN}`
    const body = { name, networkId, vmOfferingId: smallTier, templateId: unlisted.id, clusterId, diskSizeGb: null }
    log(`VM-22 template ${unlisted.name} (${unlisted.id})`)
    expectError(await call('tenant', 'POST', '/v1/tenant/vms', body, newKey()), 404, 'TEMPLATE_NOT_FOUND')
    const vms = await get('tenant', '/v1/tenant/vms') as any[]
    expect(vms.filter((v) => v.name === name)).toEqual([])
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Networking/Network/Network.cs BeginVmDeployment (NETWORK_CLUSTER_MISMATCH)
  test('VM-12 a VM in another cluster than its network is 422 NETWORK_CLUSTER_MISMATCH', async () => {
    const clusters = await get('anonymous', '/v1/clusters') as Array<{ id: string }>
    const usable: string[] = []
    for (const cluster of clusters) {
      const templates = await get('tenant', `/v1/templates?clusterId=${cluster.id}`) as any[]
      if (templates.length > 0) {
        usable.push(cluster.id)
      }
    }
    test.skip(usable.length < 2, `N/A: one cluster with templates (${usable.join(',')})`)
    const { clusterId, smallTier } = await envOf()
    const other = usable.find((z) => z !== clusterId)!
    const templates = await get('tenant', `/v1/templates?clusterId=${other}`) as any[]
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: `rg-vmz-${RUN}`, networkId, vmOfferingId: smallTier, templateId: templates[0].id, clusterId: other, diskSizeGb: null }, newKey()),
      422, 'NETWORK_CLUSTER_MISMATCH')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmEndpoint.cs HandleAsync; current comes from the reconciler:
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/UpdateVmStatusCommandHandler.cs HandleAsync (vm.MarkObserved)
  test('VM-01 a VM of the smallest tier is 202 {vmId}, then Running or Ready with an address', async () => {
    const { smallTier } = await envOf()
    vmA = await createVm(nameA, smallTier, networkId)
    made.push(vmA)
    const vm = await waitVm('VM-01', vmA, (v) => runs(v) && v.ipAddress !== null)
    expect(vm.currentExistence).toBe('Exists')
    expect(vm.vmOfferingId).toBe(smallTier)
    const actions = await activityOf(nameA)
    log(`ACT-01 create ${nameA}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.create_requested')).toBe(1)
    expect(countOf(actions, 'vm.created')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync (ExistsByNameAsync ⇒ VM_NAME_TAKEN)
  test('VM-10 a second VM with a live name is 409 VM_NAME_TAKEN', async () => {
    const { smallTier, clusterId, templateId } = await envOf()
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: nameA, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()), 409, 'VM_NAME_TAKEN')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs HandleAsync (offeringRepo.FindByIdAsync) — the tier asked for is resolved and kept on the VM
  test('VM-02 a VM of the next tier runs too', async () => {
    const { otherTier } = await envOf()
    vmB = await createVm(nameB, otherTier, networkId)
    made.push(vmB)
    const vm = await waitVm('VM-02', vmB, (v) => runs(v) && v.ipAddress !== null)
    expect(vm.currentExistence).toBe('Exists')
    expect(vm.vmOfferingId).toBe(otherTier)
  })

  // Public IPv6 is the network's (OpenViCloud/titan-ops:docs/features/network/design.md#ipv6-public): the VM has no switch, and on the run
  // network (no public IPv6) the reconciler reports no global IPv6 — OpenViCloud/titan-incus-worker:resource/vm/reconcile.go
  test('VM-13 a VM on a network without public IPv6 has no IPv6 switch and no public IPv6 address', async () => {
    const vm = await get('tenant', `/v1/tenant/vms/${vmA}`)
    expect(runs(vm)).toBe(true)
    expect('enablePublicIpv6' in vm).toBe(false)
    expect(vm.publicIpv6Address).toBeNull()
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Compute/Vm/Vm.cs RequestStop · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/StopVmEndpoint.cs HandleAsync
  test('VM-03 stop from Running is 202, then Stopped with desired Stopped', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    const vm = await waitVm('VM-03', vmA, (v) => v.currentState === 'Stopped' && v.transition === null)
    expect(vm.desiredState).toBe('Stopped')
    const actions = await activityOf(nameA)
    expect(countOf(actions, 'vm.stop_requested')).toBe(1)
    expect(countOf(actions, 'vm.stopped')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/StopVmCommandHandler.cs HandleAsync (alreadyStopped) — already stopped answers like the first request
  test('VM-04 stop again on a Stopped VM is 202 and records nothing (ACT-03)', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    const vm = await getVm(vmA)
    expect(vm.transition).toBeNull()
    expect(countOf(await activityOf(nameA), 'vm.stop_requested')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Compute/Vm/Vm.cs RequestStart · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/StartVmEndpoint.cs HandleAsync
  test('VM-05 start from Stopped is 202, then Running or Ready', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/start`), 202)
    await waitVm('VM-05', vmA, (v) => runs(v) && v.transition === null)
    expect(countOf(await activityOf(nameA), 'vm.started')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/StartVmCommandHandler.cs HandleAsync (alreadyRunning) — already running answers 202
  test('VM-06 start on a running VM is 202 and changes nothing', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/start`), 202)
    const vm = await getVm(vmA)
    expect(vm.transition).toBeNull()
    expect(countOf(await activityOf(nameA), 'vm.start_requested')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/StopVmCommandHandler.cs HandleAsync (stopIsWaiting: a stop repeated while it waits is
  // sent again under its key) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Compute/Vm/Vm.cs RequestStart (start while another request waits)
  test('VM-07 start while a stop waits is 422 VM_INVALID_STATUS', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    // VM-04, the other half: a stop repeated while it waits is 202 and records no second request.
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/stop`), 202)
    expect(countOf(await activityOf(nameA), 'vm.stop_requested')).toBe(2)
    expectError(await call('tenant', 'POST', `/v1/tenant/vms/${vmA}/start`), 422, 'VM_INVALID_STATUS')
    await waitVm('VM-07 stop lands', vmA, (v) => v.currentState === 'Stopped' && v.transition === null)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/RenameVmCommandHandler.cs HandleAsync (alreadyNamedSo) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/UpdateVmEndpoint.cs HandleAsync
  test('VM-08 rename is 204; the same name again is a 204 no-op', async () => {
    const reply = await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: renamed })
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    expect((await getVm(vmA)).name).toBe(renamed)
    expectStatus(await call('tenant', 'PATCH', `/v1/tenant/vms/${vmA}`, { name: renamed }), 204)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Compute/Vm/Vm.cs RequestDelete (RequestDelete takes over a waiting stop)
  test('VM-17 delete while a stop waits wins: 202, then Deleted', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmB}/stop`), 202)
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmB}`), 202)
    await waitVm('VM-17', vmB, (v) => v.currentExistence === 'Deleted')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmRepository.cs CountActiveByTenantAsync — counted: desired Exists and (Exists, or NotCreated with a request waiting)
  test('VM-15 a create that gave up does not count: one more VM fits, the next is 422 VM_QUOTA_EXCEEDED', async () => {
    const vms = await get('tenant', '/v1/tenant/vms') as any[]
    const counted = vms.filter((v) => v.desiredExistence === 'Exists' && v.currentExistence === 'Exists').length
    log(`VM-15 counted=${counted} (${vms.map((v) => `${v.name}:${v.currentExistence}/${v.desiredExistence}/${v.requestFailureReason}`).join(' ')})`)
    // A create that gave up and is still listed stays out of the count: VmRepositoryStateTests measures that rule;
    // on Incus nothing in this module makes a create give up any more.
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, { maxVms: counted + 1, maxNetworks: originalQuota!.maxNetworks }), 204)
    const { smallTier, clusterId, templateId } = await envOf()
    // A client that still sends the removed VM field is answered as before, not refused (portal before its update).
    const fits = await createVm(`rg-vmq-${RUN}`, smallTier, networkId, { enablePublicIpv6: true })
    made.push(fits)
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: `rg-vmq2-${RUN}`, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null }, newKey()), 422, 'VM_QUOTA_EXCEEDED')
    expectStatus(await call('admin', 'PATCH', `/v1/tenants/${tenantId}/quota`, originalQuota), 204)
    await waitVm('VM-15 extra VM has an instance', fits, (v) => v.currentExistence === 'Exists')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Compute/ComputeOwnership.cs RequireVmAsync
  test("VM-19 another tenant's VM is 404 VM_NOT_FOUND", async () => {
    expectError(await call('admin', 'GET', `/v1/tenant/vms/${vmA}`), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'DELETE', `/v1/tenant/vms/${vmA}`), 404, 'VM_NOT_FOUND')
    expect((await getVm(vmA)).desiredExistence).toBe('Exists')
  })


  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/DeleteNetworkCommandHandler.cs HandleAsync (NETWORK_NOT_EMPTY)
  test('VM-21 deleting the run network while a VM lives on it is 422 NETWORK_NOT_EMPTY', async () => {
    expectError(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}`), 422, 'NETWORK_NOT_EMPTY')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/DeleteVmEndpoint.cs HandleAsync ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/DeleteVmCommandHandler.cs HandleAsync (vm.IsTerminal: a Deleted VM answers 202) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/UpdateVmStatusCommandHandler.cs HandleAsync (case "Deleted": vm.MarkDeleted())
  test('VM-16 delete is 202, then Deleted; a repeat is 202', async () => {
    const reply = await call('tenant', 'DELETE', `/v1/tenant/vms/${vmA}`)
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    await waitVm('VM-16', vmA, (v) => v.currentExistence === 'Deleted')
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${vmA}`), 202)
    const actions = await activityOf(renamed)
    log(`ACT-01 delete ${renamed}: ${actions.join(', ')}`)
    expect(countOf(actions, 'vm.delete_requested')).toBe(1)
    expect(countOf(actions, 'vm.deleted')).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmRepository.cs ExistsByNameAsync — a Deleted VM no longer holds its name
  test('VM-18 a new VM may take the name of a Deleted one', async () => {
    const { smallTier } = await envOf()
    const again = await createVm(renamed, smallTier, networkId)
    made.push(again)
    await waitVm('VM-18 has an instance', again, (v) => v.currentExistence === 'Exists')
    const reply = await call('tenant', 'GET', `/v1/tenant/vms/${again}`)
    expect(bodyOf(reply).name).toBe(renamed)
  })
})
