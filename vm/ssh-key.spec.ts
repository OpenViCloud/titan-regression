import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, startLog } from './api'
import { RUN, activityOf, countOf, envOf, runNetwork } from './fixtures'

// Cases SSH-01..05 of plan.md: tenant SSH keys through the API. The key in the guest is VM-24 (host).
// The fingerprints are what `ssh-keygen -lf` printed for these keys: the oracle is outside the code under test.
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJQIuvIctzZ61SoksnjJlkCRERFjIowWaKhlaoSOsHMB alice@laptop'
const ED25519_FINGERPRINT = 'SHA256:iruZOXrfD+ZK21g+LvOgxbzdggbMluG+IMSJLD4JlN0'
const ECDSA256 =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBIMiFu3klbiZ+CGMJP2XmpmPwfA7gnGTqgAWypl/msVzDaBvj4PXhbcQ514NbHNMXWZqbOWMXMi5ew5ucFMvGpc= e256'
const RSA1024 =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDY33MdmAGIslfV/bpc5tFTotwR7lu+jCqkdbQgiRRi5Ogh4WQpJg3Lh5V7VtOf+vHKvWBLEcZS5Mc9meSoOwlQJJYvzrFwpbXyY4mqsAe2TkJuw2O8wG95S3bebVl4QjRJm0yx5m6qjhZwktKrpqLSdjB3KnwX58efWGTdrD13/Q== rsa1024'

type Key = { id: string, name: string, type: string, fingerprint: string, createdAt: string }

async function listKeys(as: 'tenant' | 'admin'): Promise<Key[]> {
  return await get(as, '/v1/tenant/ssh-keys') as Key[]
}

test.describe.serial('ssh-key', () => {
  const name = `rg-ssh-${RUN}`
  let keyId = ''

  test.beforeAll(async ({ browser }) => {
    startLog('ssh-key')
    useBrowser(browser)
    // A key left by a run killed midway would make SSH-01 a 409: remove test keys before starting.
    for (const key of await listKeys('tenant')) {
      if (key.name.startsWith('rg-ssh-')) {
        log(`removing leftover key ${key.name}`)
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${key.id}`), 204)
      }
    }
  })

  test.afterAll(async () => {
    for (const key of await listKeys('tenant')) {
      if (key.name.startsWith('rg-ssh-')) {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${key.id}`), 204)
      }
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/SshKey/AddSshKeyEndpoint.cs (HandleAsync: SendAsync(result, 201)) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/SshKey/ListSshKeysEndpoint.cs (Configure: Get("v1/tenant/ssh-keys"))
  test('SSH-01 add a key: 201 id only, the list shows the ssh-keygen fingerprint', async () => {
    const before = Date.now()
    const reply = await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name, publicKey: ED25519 }, newKey())
    expectStatus(reply, 201)
    const body = bodyOf(reply)
    expect(Object.keys(body)).toEqual(['id'])
    keyId = body.id

    const listed = (await listKeys('tenant')).find((k) => k.id === keyId)
    expect(listed).toBeDefined()
    expect(listed!.name).toBe(name)
    expect(listed!.type).toBe('ssh-ed25519')
    expect(listed!.fingerprint).toBe(ED25519_FINGERPRINT)
    expect(Date.parse(listed!.createdAt)).toBeGreaterThan(before - 5 * 60_000)
    log(`SSH-01 key ${keyId} ${listed!.fingerprint}`)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/SshKey/AddSshKeyCommandHandler.cs HandleAsync (SSH_KEY_EXISTS, SSH_KEY_NAME_TAKEN)
  test('SSH-02 the same key under another comment is 409 SSH_KEY_EXISTS; the same name is 409 SSH_KEY_NAME_TAKEN', async () => {
    const otherComment = ED25519.replace('alice@laptop', 'someone-else')
    expectError(await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name: `${name}-b`, publicKey: otherComment }, newKey()),
      409, 'SSH_KEY_EXISTS')
    expectError(await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name, publicKey: ECDSA256 }, newKey()),
      409, 'SSH_KEY_NAME_TAKEN')
    expect((await listKeys('tenant')).filter((k) => k.name.startsWith(name)).length).toBe(1)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/SshKey/AddSshKeyEndpoint.cs AddSshKeyValidator (PublicKey and Name rules)
  test('SSH-03 a malformed key, an RSA key under 2048 bits and a 65-character name are 400 VALIDATION_ERROR', async () => {
    const count = (await listKeys('tenant')).length
    expectError(await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name: `${name}-c`, publicKey: 'ssh-ed25519 nope' }, newKey()),
      400, 'VALIDATION_ERROR')
    expectError(await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name: `${name}-c`, publicKey: RSA1024 }, newKey()),
      400, 'VALIDATION_ERROR')
    expectError(await call('tenant', 'POST', '/v1/tenant/ssh-keys', { name: 'rg-ssh-' + 'k'.repeat(58), publicKey: ECDSA256 }, newKey()),
      400, 'VALIDATION_ERROR')
    expect((await listKeys('tenant')).length).toBe(count)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/CreateVmCommandHandler.cs VendorDataForKeysAsync (SSH_KEY_NOT_FOUND): checked before the VM row is added, so nothing is made.
  test('SSH-04 creating a VM with an unknown key id is 404 SSH_KEY_NOT_FOUND and makes no VM', async () => {
    const networkId = (await runNetwork()).id
    const { clusterId, templateId, smallTier } = await envOf()
    const vmName = `rg-vmssh-${RUN}`
    expectError(await call('tenant', 'POST', '/v1/tenant/vms',
      { name: vmName, networkId, vmOfferingId: smallTier, templateId, clusterId, diskSizeGb: null, sshKeyIds: [randomUUID()] }, newKey()),
      404, 'SSH_KEY_NOT_FOUND')
    const vms = await get('tenant', '/v1/tenant/vms') as Array<{ name: string }>
    expect(vms.filter((v) => v.name === vmName)).toEqual([])
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/SshKey/DeleteSshKeyCommandHandler.cs HandleAsync (another tenant's key is not found) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/SshKey/DeleteSshKeyEndpoint.cs (Configure: Delete("v1/tenant/ssh-keys/{sshKeyId:guid}"), 204)
  test('SSH-05 another tenant cannot see or delete the key; the owner deletes it once, then 404', async () => {
    expect((await listKeys('admin')).map((k) => k.id)).not.toContain(keyId)
    expectError(await call('admin', 'DELETE', `/v1/tenant/ssh-keys/${keyId}`), 404, 'SSH_KEY_NOT_FOUND')
    expect((await listKeys('tenant')).map((k) => k.id)).toContain(keyId)

    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${keyId}`), 204)
    expectError(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${keyId}`), 404, 'SSH_KEY_NOT_FOUND')
    expect((await listKeys('tenant')).map((k) => k.id)).not.toContain(keyId)

    const actions = await activityOf(name)
    log(`SSH-05 activity ${JSON.stringify(actions)}`)
    for (const action of ['ssh_key.create_requested', 'ssh_key.created', 'ssh_key.delete_requested', 'ssh_key.deleted']) {
      expect(countOf(actions, action), action).toBe(1)
    }
  })
})
