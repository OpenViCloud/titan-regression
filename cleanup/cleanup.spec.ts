import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { call, expectStatus, get, log, pollUntil, startLog } from './api'
import { deleteVmAndWait, existenceShape, readVolume, waitNetwork, waitVolume } from './fixtures'

// Case CLN-01 of plan.md (CLN-02 reads the Incus host). Runs after every module that leaves rg-* resources: removes every
// rg-* resource of the lane's tenant a module left behind, and the tfacc-* ones a red terraform-provider run left (that module
// runs after this one, so a red run is followed by one more cleanup job), in an order Titan accepts — load balancers (a VM a live
// one sends to refuses its delete: titan-ops features/load-balancer/design.md#lb-and-vm-network), rules, VMs (their snapshots go
// with them, attached volumes are released: titan-ops features/volume/design.md#vm-delete-releases-volumes), volume snapshots,
// volumes, networks, SSH keys, API tokens.
function isTest(r: { name: string }): boolean {
  return r.name.startsWith('rg-') || r.name.startsWith('tfacc-')
}

test.describe.serial('cleanup', () => {
  test.describe.configure({ timeout: 30 * 60_000 })

  test.beforeAll(async ({ browser }) => {
    startLog('cleanup')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await closeSessions()
  })

  // Rules go with their network (OpenViCloud/titan-control-plane:Titan.Application/Commands/Networking/Network/UpdateNetworkStatusCommandHandler.cs
  // HandleAsync, case Deleted: network.MarkDeleted(), the rule being the network's child entity), VM snapshots with their VM
  // (OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/UpdateVmStatusCommandHandler.cs HandleAsync, case Deleted:
  // MarkAllDeletedByVmIdAsync); lists hide Deleted (OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmRepository.cs ListByTenantAsync).
  // SSH keys and API tokens are hard deletes answered 204:
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/SshKey/DeleteSshKeyCommandHandler.cs (HandleAsync: repo.Remove),
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Platform/ApiToken/DeleteApiTokenCommandHandler.cs (HandleAsync: repo.Remove),
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/SshKey/DeleteSshKeyEndpoint.cs (HandleAsync: SendNoContentAsync),
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/ApiToken/DeleteApiTokenEndpoint.cs (HandleAsync: SendNoContentAsync).
  // A leftover token counts toward the tenant's 20 forever (titan-ops features/public-api/design.md#api-token).
  test('CLN-01 no rg-* or tfacc-* load balancer, network, VM, volume, snapshot, SSH key or API token is left', async () => {
    for (const lb of (await get('tenant', '/v1/tenant/load-balancers') as any[]).filter(isTest)) {
      log(`CLN-01 load balancer ${lb.name}`)
      await pollUntil(`load balancer ${lb.name} at rest`, () => get('tenant', `/v1/tenant/load-balancers/${lb.id}`),
        (row) => row.transition === null || row.transition === 'Deleting', existenceShape)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/load-balancers/${lb.id}`), 202)
      await pollUntil(`load balancer ${lb.name} deleted`, () => get('tenant', `/v1/tenant/load-balancers/${lb.id}`),
        (row) => row.currentExistence === 'Deleted', existenceShape)
    }

    const networks = (await get('tenant', '/v1/tenant/networks') as any[]).filter(isTest)
    for (const network of networks) {
      const rules = await get('tenant', `/v1/tenant/networks/${network.id}/firewall-rules`) as any[]
      for (const rule of rules) {
        if (rule.desiredExistence !== 'Exists') {
          continue
        }
        await pollUntil(`rule ${rule.id} settles`, async () => {
          const rows = await get('tenant', `/v1/tenant/networks/${network.id}/firewall-rules`) as any[]
          return rows.find((r) => r.id === rule.id) || { transition: null }
        }, (r) => r.transition === null, existenceShape)
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${network.id}/firewall-rules/${rule.id}`), 204)
        log(`CLN-01 rule ${rule.id} delete asked`)
      }
    }

    for (const vm of (await get('tenant', '/v1/tenant/vms') as any[]).filter(isTest)) {
      log(`CLN-01 vm ${vm.name}`)
      await deleteVmAndWait(vm.id)
    }

    for (const volume of (await get('tenant', '/v1/tenant/volumes') as any[]).filter(isTest)) {
      log(`CLN-01 volume ${volume.name}`)
      await waitVolume(`volume ${volume.name} at rest`, volume.id, (v) => v.transition === null || v.currentExistence === 'Deleted')
      for (const snapshot of await get('tenant', `/v1/tenant/volumes/${volume.id}/snapshots`) as any[]) {
        if (snapshot.desiredExistence === 'Exists') {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volume.id}/snapshots/${snapshot.id}`), 202)
        }
      }
      await pollUntil(`snapshots of ${volume.name} gone`, () => get('tenant', `/v1/tenant/volumes/${volume.id}/snapshots`) as Promise<any[]>,
        (rows) => rows.length === 0, (rows) => `${rows.length} left`)
      if ((await readVolume(volume.id)).currentExistence !== 'Deleted') {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volume.id}`), 202)
        await waitVolume(`volume ${volume.name} deleted`, volume.id, (v) => v.currentExistence === 'Deleted')
      }
    }

    for (const network of (await get('tenant', '/v1/tenant/networks') as any[]).filter(isTest)) {
      log(`CLN-01 network ${network.name}`)
      await waitNetwork(`network ${network.name} at rest`, network.id, (n) => n.transition === null || n.currentExistence === 'Deleted')
      if (network.desiredExistence === 'Exists') {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${network.id}`), 202)
      }
      await waitNetwork(`network ${network.name} deleted`, network.id, (n) => n.currentExistence === 'Deleted')
    }

    for (const key of (await get('tenant', '/v1/tenant/ssh-keys') as any[]).filter(isTest)) {
      log(`CLN-01 ssh key ${key.name}`)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${key.id}`), 204)
    }

    for (const token of (await get('tenant', '/v1/tenant/api-tokens') as any[]).filter(isTest)) {
      log(`CLN-01 api token ${token.name}`)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${token.id}`), 204)
    }

    const left = [
      ...(await get('tenant', '/v1/tenant/load-balancers') as any[]),
      ...(await get('tenant', '/v1/tenant/networks') as any[]),
      ...(await get('tenant', '/v1/tenant/vms') as any[]),
      ...(await get('tenant', '/v1/tenant/volumes') as any[]),
      ...(await get('tenant', '/v1/tenant/ssh-keys') as any[]),
      ...(await get('tenant', '/v1/tenant/api-tokens') as any[]),
    ].filter(isTest).map((r) => r.name)
    log(`CLN-01 left: [${left.join(', ')}]`)
    expect(left).toEqual([])
  })
})
