import { test, expect } from '@playwright/test'
import { generateKeyPairSync } from 'node:crypto'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectStatus, get, log, newKey, pollUntil, startLog } from './api'
import { runNetwork } from './fixtures'

// Cases CON-10, CON-11, CON-13 of plan.md. The spec the host serves (OpenViCloud/titan-control-plane:Titan.Tests/Api/OpenApiSpecTests.cs SpecUrl)
// is the same document as OpenViCloud/titan-control-plane:api/openapi-v1.json, committed in that repository
// (OpenViCloud/titan-control-plane:Titan.Tests/Api/OpenApiSpecTests.cs OpenApiSpec_MatchesCommittedBaseline pins the two equal), so reading it from
// the running env is reading the contract.
//
// This module runs while the shared run network (rg-net-<run>) is still alive: network-lifecycle (a later module)
// deletes it. So CON-10/11 never create or delete that network — they use fixtures' runNetwork() and only rename
// it (restored in finally) to get a measured 204 on a route they do not otherwise exercise here.
//
// VM/volume/snapshot/load-balancer creates are expensive (provider work, minutes to observe); this spec does not
// create any of them. Their declared codes are asserted against the documented expectation
// (OpenViCloud/titan-ops:docs/features/public-api/design.md#success-codes) and the codes vm.spec.ts/volume.spec.ts/vm-snapshot.spec.ts/
// load-balancer.spec.ts already assert the live API returns for those routes.

type Spec = { paths: Record<string, Record<string, any>>, components: { schemas: Record<string, any> } }

let specCache: Spec | null = null

async function fetchSpec(): Promise<Spec> {
  if (specCache !== null) {
    return specCache
  }
  const reply = await call('anonymous', 'GET', '/swagger/v1/swagger.json')
  expectStatus(reply, 200)
  specCache = JSON.parse(reply.text) as Spec
  return specCache
}

// Matches a concrete request path (e.g. /v1/tenant/networks/abc-123) to the templated path the spec declares
// (/v1/tenant/networks/{networkId}) by trying every templated path of the same segment count.
function operationOf(spec: Spec, method: string, concretePath: string): any {
  const concreteSegments = concretePath.split('/').filter((s) => s !== '')
  for (const [template, methods] of Object.entries(spec.paths)) {
    const templateSegments = template.split('/').filter((s) => s !== '')
    if (templateSegments.length !== concreteSegments.length) {
      continue
    }
    const matches = templateSegments.every((seg, i) => seg.startsWith('{') || seg === concreteSegments[i])
    if (matches && methods[method.toLowerCase()] !== undefined) {
      return methods[method.toLowerCase()]
    }
  }
  throw new Error(`no operation in the spec matches ${method} ${concretePath}`)
}

// Asserts the spec declares exactly one 2xx response for this call, equal to the status actually returned, and
// that a body is declared exactly when one was sent (OpenViCloud/titan-ops:docs/features/public-api/design.md#success-codes).
async function assertDeclaredCode(label: string, method: string, path: string, status: number, hasBody: boolean): Promise<void> {
  const spec = await fetchSpec()
  const op = operationOf(spec, method, path)
  const twoxx = Object.keys(op.responses).filter((code) => code.startsWith('2'))
  log(`${label} ${method} ${path} → ${status} (spec declares ${twoxx.join(',')})`)
  expect(twoxx.length, `${label}: exactly one 2xx declared for ${method} ${path}`).toBe(1)
  expect(Number(twoxx[0])).toBe(status)
  const declaresBody = op.responses[twoxx[0]].content !== undefined
  expect(declaresBody, `${label}: ${method} ${path} declares a body exactly when one is sent`).toBe(hasBody)
}

// Resolves a state/status field's schema to the list of allowed string values, unwrapping nullable `allOf` wrappers
// the way OpenViCloud/titan-control-plane:Titan.Tests/Api/StateEnumSpecTests.cs StateField_IsTheDomainEnum does (oapi-codegen turns a nullable $ref into allOf + nullable).
function enumOf(spec: Spec, schemaName: string, field: string): { values: string[], nullable: boolean } {
  const property = spec.components.schemas[schemaName]?.properties?.[field]
  expect(property, `${schemaName}.${field} must exist in the spec`).toBeDefined()
  const nullable = property.nullable === true
  let target = property
  if (property.allOf !== undefined) {
    expect(property.allOf.length).toBe(1)
    target = property.allOf[0]
  }
  expect(target.$ref, `${schemaName}.${field} is not an enum reference: ${JSON.stringify(property)}`).toBeDefined()
  const refName = (target.$ref as string).split('/').pop()!
  const enumSchema = spec.components.schemas[refName]
  expect(enumSchema.type).toBe('string')
  return { values: enumSchema.enum as string[], nullable }
}

function assertEnumField(spec: Spec, schemaName: string, field: string, row: any): void {
  const { values, nullable } = enumOf(spec, schemaName, field)
  const value = row[field]
  if (value === null) {
    expect(nullable, `${schemaName}.${field} is null but the spec marks it non-nullable`).toBe(true)
    return
  }
  expect(values, `${schemaName}.${field} = ${JSON.stringify(value)} is not one of the spec's enum`).toContain(value)
}

function ed25519PublicKey(comment: string): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const raw = der.subarray(der.length - 32)
  const chunk = (buf: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(buf.length, 0)
    return Buffer.concat([len, buf])
  }
  const blob = Buffer.concat([chunk(Buffer.from('ssh-ed25519')), chunk(raw)])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

test.describe.serial('contract-spec', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  let networkId = ''
  let networkName = ''
  let renamedTo = ''
  let ruleId = ''
  let sshKeyId = ''

  // A rule whose create is still waiting refuses delete with 422 FIREWALL_RULE_NOT_READY
  // (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Networking/FirewallRule/FirewallRule.cs RequestDelete) — wait until it is at rest.
  async function ruleSettled(id: string): Promise<any> {
    const read = async () => {
      const rows = await get('tenant', `/v1/tenant/networks/${networkId}/firewall-rules`) as any[]
      const row = rows.find((r) => r.id === id)
      return row === undefined ? { currentExistence: 'Gone', transition: null } : row
    }
    return pollUntil(`rule ${id} at rest`, read, (r) => r.transition === null,
      (r) => `existence=${r.currentExistence} desired=${r.desiredExistence} transition=${r.transition}`)
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('contract-spec')
    useBrowser(browser)
    const network = await runNetwork()
    networkId = network.id
    networkName = network.name
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    if (sshKeyId !== '') {
      await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${sshKeyId}`)
    }
    if (ruleId !== '') {
      const rule = await ruleSettled(ruleId)
      if (rule.currentExistence !== 'Gone' && rule.desiredExistence !== 'Deleted') {
        await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}/firewall-rules/${ruleId}`)
      }
    }
    if (renamedTo !== '') {
      // Rename the run network back: network-lifecycle finds it by the rg-net- prefix, and later modules
      // that read its name expect the one they created it with.
      await call('tenant', 'PATCH', `/v1/tenant/networks/${networkId}`, { name: networkName })
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Host/Program.cs UseSwaggerGen() — unconditional, every env serves the same document
  // OpenViCloud/titan-control-plane:Titan.Tests/Api/OpenApiSpecTests.cs OpenApiSpec_MatchesCommittedBaseline asserts equals OpenViCloud/titan-control-plane:api/openapi-v1.json.
  test('CON-10 declared success codes match what cheap routes actually return', async () => {
    // create rule: 201 with an id-only body (CreateFirewallRuleCommandResult)
    const ruleReply = await call('tenant', 'POST', `/v1/tenant/networks/${networkId}/firewall-rules`,
      { direction: 'Ingress', protocol: 'TCP', startPort: 22, endPort: 22, cidr: '0.0.0.0/0' }, newKey())
    expectStatus(ruleReply, 201)
    ruleId = bodyOf(ruleReply).ruleId as string
    await assertDeclaredCode('CON-10 rule create', 'POST', `/v1/tenant/networks/${networkId}/firewall-rules`, 201, true)

    // ssh key create: 201 with an id-only body
    const keyReply = await call('tenant', 'POST', '/v1/tenant/ssh-keys',
      { name: `rg-conkey-${Date.now().toString(36)}`, publicKey: ed25519PublicKey('rg-contract') }, newKey())
    expectStatus(keyReply, 201)
    sshKeyId = bodyOf(keyReply).id as string
    await assertDeclaredCode('CON-10 ssh key create', 'POST', '/v1/tenant/ssh-keys', 201, true)

    // rename (PUT/PATCH): 204, no body — OpenViCloud/titan-ops:docs/architecture/http-contract.md#commands-return-no-data
    renamedTo = `${networkName}-rg`
    const renameReply = await call('tenant', 'PATCH', `/v1/tenant/networks/${networkId}`, { name: renamedTo })
    expectStatus(renameReply, 204)
    expect(renameReply.text).toBe('')
    await assertDeclaredCode('CON-10 network rename', 'PATCH', `/v1/tenant/networks/${networkId}`, 204, false)
    const renameBack = await call('tenant', 'PATCH', `/v1/tenant/networks/${networkId}`, { name: networkName })
    expectStatus(renameBack, 204)
    renamedTo = ''

    // GET: 200 with a body
    const getReply = await call('tenant', 'GET', `/v1/tenant/networks/${networkId}`)
    expectStatus(getReply, 200)
    await assertDeclaredCode('CON-10 network get', 'GET', `/v1/tenant/networks/${networkId}`, 200, true)

    // network create: 202 WITH a body (id-only) — unlike a delete or stop/start, a create answers the id
    // (OpenViCloud/titan-ops:docs/architecture/http-contract.md#create-returns-id), so 202 does not always mean "no body".
    await assertDeclaredCode('CON-10 network create (not exercised here)', 'POST', '/v1/tenant/networks', 202, true)

    // delete rule: 204, no body
    await ruleSettled(ruleId)
    const deleteRuleReply = await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}/firewall-rules/${ruleId}`)
    expectStatus(deleteRuleReply, 204)
    expect(deleteRuleReply.text).toBe('')
    await assertDeclaredCode('CON-10 rule delete', 'DELETE', `/v1/tenant/networks/${networkId}/firewall-rules/${ruleId}`, 204, false)
    ruleId = ''

    // delete ssh key: 204, no body
    const deleteKeyReply = await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${sshKeyId}`)
    expectStatus(deleteKeyReply, 204)
    await assertDeclaredCode('CON-10 ssh key delete', 'DELETE', `/v1/tenant/ssh-keys/${sshKeyId}`, 204, false)
    sshKeyId = ''

    // network delete: 202, no body — documented expectation, not exercised (network-lifecycle owns the run network)
    await assertDeclaredCode('CON-10 network delete (not exercised here)', 'DELETE', '/v1/tenant/networks/{networkId}', 202, false)
  })

  // OpenViCloud/titan-ops:docs/features/public-api/design.md#state-enums — every currentState/desiredState/currentExistence/
  // desiredExistence/transition (and tenant/invoice/topup status) is null or a value the spec's enum declares for
  // that field. Lists may be empty elsewhere in the run, but the run network + a fresh rule make the network and
  // firewall-rule checks non-empty here.
  test('CON-11 every state/existence/transition field read back is null or a declared enum value', async () => {
    const spec = await fetchSpec()

    const networks = await get('tenant', '/v1/tenant/networks') as any[]
    expect(networks.length).toBeGreaterThan(0)
    for (const row of networks) {
      for (const field of ['currentState', 'currentExistence', 'desiredExistence', 'transition']) {
        assertEnumField(spec, 'NetworkQueryResult', field, row)
      }
    }

    const rules = await get('tenant', `/v1/tenant/networks/${networkId}/firewall-rules`) as any[]
    const ruleReply = await call('tenant', 'POST', `/v1/tenant/networks/${networkId}/firewall-rules`,
      { direction: 'Ingress', protocol: 'TCP', startPort: 2222, endPort: 2222, cidr: '0.0.0.0/0' }, newKey())
    expectStatus(ruleReply, 201)
    ruleId = bodyOf(ruleReply).ruleId as string
    const withNewRule = await pollUntil('CON-11 rule created',
      () => get('tenant', `/v1/tenant/networks/${networkId}/firewall-rules`) as Promise<any[]>,
      (rows) => rows.length > rules.length, (rows) => `${rows.length} rules`)
    expect(withNewRule.length).toBeGreaterThan(0)
    for (const row of withNewRule) {
      for (const field of ['currentState', 'currentExistence', 'desiredExistence', 'transition']) {
        assertEnumField(spec, 'FirewallRuleQueryResult', field, row)
      }
    }
    await ruleSettled(ruleId)
    expectStatus(await call('tenant', 'DELETE', `/v1/tenant/networks/${networkId}/firewall-rules/${ruleId}`), 204)
    ruleId = ''

    // These lists may legitimately be empty at contract time (no VM/volume/LB created by this module) —
    // the check still holds vacuously, and the network/rule checks above cover the non-empty case.
    for (const [path, schema] of [
      ['/v1/tenant/vms', 'VmQueryResult'],
      ['/v1/tenant/volumes', 'VolumeQueryResult'],
      ['/v1/tenant/load-balancers', 'LoadBalancerQueryResult'],
    ] as const) {
      const rows = await get('tenant', path) as any[]
      log(`CON-11 ${path}: ${rows.length} row(s)`)
      for (const row of rows) {
        const fields = schema === 'VmQueryResult'
          ? ['currentState', 'desiredState', 'currentExistence', 'desiredExistence', 'transition']
          : ['currentExistence', 'desiredExistence', 'transition']
        for (const field of fields) {
          assertEnumField(spec, schema, field, row)
        }
        if (schema === 'VolumeQueryResult') {
          const snapshots = await get('tenant', `${path}/${row.id}/snapshots`) as any[]
          for (const snap of snapshots) {
            for (const field of ['currentExistence', 'desiredExistence', 'transition']) {
              assertEnumField(spec, 'VolumeSnapshotQueryResult', field, snap)
            }
          }
        }
        if (schema === 'VmQueryResult') {
          const snapshots = await get('tenant', `${path}/${row.id}/snapshots`) as any[]
          for (const snap of snapshots) {
            for (const field of ['currentExistence', 'desiredExistence', 'transition']) {
              assertEnumField(spec, 'VmSnapshotQueryResult', field, snap)
            }
          }
        }
      }
    }

    const tenant = await get('tenant', '/v1/tenant')
    assertEnumField(spec, 'TenantQueryResult', 'status', tenant)

    const invoices = await get('tenant', '/v1/tenant/billing/invoices') as any[]
    log(`CON-11 invoices: ${invoices.length} row(s)`)
    for (const row of invoices) {
      assertEnumField(spec, 'InvoiceQueryResult', 'status', row)
    }

    const topups = await get('tenant', '/v1/tenant/topups') as any[]
    log(`CON-11 topups: ${topups.length} row(s)`)
    for (const row of topups) {
      assertEnumField(spec, 'TopUpQueryResult', 'status', row)
    }
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Catalog/ListTemplatesEndpoint.cs (ListTemplatesRequest: [QueryParam] ClusterId)
  // · OpenViCloud/titan-ops:docs/features/public-api/design.md#spec-breaking-gate
  test('CON-13 the served spec declares clusterId on GET /v1/templates as an optional query parameter', async () => {
    const spec = await fetchSpec()
    const op = spec.paths['/v1/templates']['get']
    const parameters = (op.parameters || []) as any[]
    const cluster = parameters.find((p) => p.name === 'clusterId')
    log(`CON-13 GET /v1/templates parameters=${JSON.stringify(parameters)}`)
    expect(cluster, 'clusterId must be declared').toBeTruthy()
    expect(cluster.in).toBe('query')
    expect(cluster.required === true).toBe(false)
  })
})
