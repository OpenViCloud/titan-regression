import { test, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { PORTAL, closeSessions, useBrowser } from './auth'
import { startLocalProxyIfNeeded } from './local-proxy'
import { API, RESULTS, bodyOf, call, expectStatus, get, log, newKey, sleep, startLog } from './api'
import { RUN, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, vmShape } from './fixtures'
import { cleanUp } from './clean-up'
import { newSecret } from './token'
import { BINARY, CLI_HOME, CliSshChain, type CliResult, cliAuthUrl, cliEnv, run, runCli, runWithStdin, setCliAuthUrl,
  sshOptions, untilGuestAnswers, waitForBinary } from './cli-ssh'

// Cases CLI-01..18 of plan.md, in five describes that run in this order: 'cli' (CLI-01..03, CLI-06..11),
// 'cli catalog' (CLI-05), 'cli lifecycle' (CLI-12..17), 'cli api token' (CLI-18), 'cli logout' (CLI-04). The binary is not in the image: when
// this spec logs BINARY_WAIT the agent copies `openvicloud` built for the pod's architecture from the CLI commit the
// release measures to /work/bin/openvicloud, checks sha256, then touches /work/bin/openvicloud.ready
// (OpenViCloud/titan-ops:.claude/shared/regression-suite.md §Runner).
// Tokens stay in this process.
//
// Login and the binary wait are file-level (outside every describe): Playwright restarts the worker process after
// any failed test in this file (workers: 1, fullyParallel: false — OpenViCloud/titan-local-cluster:base/regression-runner/runner-configmap.yaml),
// which drops module state (authUrl, browserRef) and re-runs only the hooks of describes that still have tests
// left — a root-level beforeAll runs again, a nested one does not. The CLI's own session lives on disk under
// CLI_HOME and survives a worker restart, so login happens at most once. A red case in CLI-06..11's serial chain
// skips the rest of the chain, so CLI-05, CLI-12..18 and CLI-04 sit in their own describes. CLI-10, the long idle
// session the edge sometimes cuts, is last of the chain. CLI-04 is last of all five because it logs the CLI out.
// The CLI runner and the bodies of CLI-06..11 are in lib/cli-ssh.ts, shared with cli/edge/cli-edge.spec.ts.

// Keycloak's device page: confirm the code, sign in, grant. Each step looks for what is on screen, since the pages
// shown depend on the Keycloak version and on whether this browser is already signed in.
async function confirmOnTheWeb(page: Page, link: string, cliDone: () => boolean): Promise<void> {
  await page.goto(link, { waitUntil: 'domcontentloaded' })
  for (let step = 0; step < 12; step++) {
    if (cliDone()) {
      return
    }
    await page.waitForLoadState('domcontentloaded')
    const username = page.locator('#username, input[name="username"]').first()
    const askedToSignIn = await username.isVisible().catch(() => false)
    if (askedToSignIn) {
      await username.fill(process.env.BETA_USER_USERNAME || 'beta-user')
      const password = process.env.BETA_USER_PASSWORD
      if (!password) {
        throw new Error('BETA_USER_PASSWORD is not set — the runner injects it')
      }
      await page.locator('#password, input[name="password"]').first().fill(password)
      await page.locator('#kc-login, button[type="submit"], input[type="submit"]').first().click()
      continue
    }
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
    if (/success|you may close|can close|device login successful/i.test(body)) {
      log(`web step ${step}: finished`)
      return
    }
    const confirm = page.getByRole('button', { name: /^(yes|grant|accept|submit|continue|confirm|sign in)/i }).first()
    const confirmInput = page.locator('#kc-login, input[type="submit"][name="accept"], input[type="submit"]').first()
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click()
      continue
    }
    if (await confirmInput.isVisible().catch(() => false)) {
      await confirmInput.click()
      continue
    }
    await page.waitForTimeout(2000)
  }
}

const chain = new CliSshChain('/work/ssh-cli', `rg-vmcli-${RUN}`, `rg-ssh-cli-${RUN}`)

// --- raw-text comparison for CLI-05: a `decimal`/json.Number field must match to every digit, which JSON.parse
// would not preserve (it normalizes "161388.0000000000" to 161388). Both sides are read as text, never parsed.
function rawNumberField(json: string, id: string, field: string): string {
  const idIndex = json.indexOf(`"id": "${id}"`) !== -1 ? json.indexOf(`"id": "${id}"`) : json.indexOf(`"id":"${id}"`)
  expect(idIndex, `object with id ${id} in: ${json.slice(0, 200)}`).toBeGreaterThanOrEqual(0)
  // The object a field belongs to is bounded by the nearest enclosing braces around its id.
  const objectStart = json.lastIndexOf('{', idIndex)
  const objectEnd = json.indexOf('}', idIndex)
  const object = json.slice(objectStart, objectEnd + 1)
  const match = object.match(new RegExp(`"${field}"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`))
  expect(match, `field ${field} of ${id} in: ${object}`).not.toBeNull()
  return match![1]
}

// File-level, outside every describe: Playwright only re-runs the beforeAll of a describe that still has tests
// left after a worker restart, but a root-level beforeAll runs again regardless of which describe failed. authUrl
// and the terms-acceptance setup must be in place for every describe below, including one that runs in a fresh
// worker after CLI-06..11 already passed in the previous one.
test.beforeAll(async ({ browser }) => {
  test.setTimeout(10 * 60_000)
  startLog('cli')
  useBrowser(browser)
  fs.mkdirSync(CLI_HOME, { recursive: true })
  // The CLI's issuer is the portal's Keycloak realm (the portal reads it from /config.json at start).
  await startLocalProxyIfNeeded(PORTAL)
  const config = await (await fetch(`${PORTAL}/config.json`)).json() as { keycloakUrl: string, keycloakRealm: string }
  setCliAuthUrl(`${config.keycloakUrl}/realms/${config.keycloakRealm}`)
  log(`cli auth url ${cliAuthUrl()}`)
  // The CLI refuses every command until the current terms are accepted (OpenViCloud/titan-cli:command/root.go Deps.Client,
  // Deps.mustAcceptTerms).
  const consent = await get('tenant', '/v1/legal/consent-status')
  if (consent.mustAcceptTerms) {
    expectStatus(await call('tenant', 'POST', '/v1/legal/acceptance'), 204)
    log('setup: beta-user accepted the current terms')
  }
  await waitForBinary()
})

test.afterAll(async () => {
  // No logout here: this hook also runs if a worker dies mid-file. CLI-04, in the last describe below,
  // is the one place that logs out.
  await closeSessions()
})

test.describe.serial('cli', () => {
  test.describe.configure({ timeout: 25 * 60_000 })

  // OpenViCloud/titan-cli:command/version.go versionInfo, NewVersion — the build and the endpoints it targets
  test('CLI-01 version prints the build and the env endpoints', async () => {
    const result = await runCli(['version', '-o', 'json'])
    log(`CLI-01 exit=${result.code} ${result.stdout.trim()}`)
    expect(result.code).toBe(0)
    const info = JSON.parse(result.stdout)
    expect(info.api).toBe(API)
    expect(info.auth).toBe(cliAuthUrl())
    expect(info.version.length).toBeGreaterThan(0)
  })

  // titan-ops features/cli/design.md#login-on-the-web; OpenViCloud/titan-cli:command/tenant/tenant.go newGet — the fields
  // `tenant get` shows
  test('CLI-02 login on the web, then `tenant get` answers what the API answers', async ({ browser }) => {
    const login = spawn(BINARY, ['auth', 'login'], { env: cliEnv() })
    let loginOut = ''
    let loginErr = ''
    let loginCode: number | null = null
    login.stdout.on('data', (chunk) => { loginOut += chunk.toString() })
    login.stderr.on('data', (chunk) => { loginErr += chunk.toString() })
    login.on('close', (code) => {
      let exit = -1
      if (code !== null) {
        exit = code
      }
      loginCode = exit
    })
    let link = ''
    for (let i = 0; i < 60 && link === ''; i++) {
      const match = loginErr.match(/(https?:\/\/\S*user_code=\S+)/)
      if (match !== null) {
        link = match[1]
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(link, `the CLI must print the device link; stderr: ${loginErr}`).not.toEqual('')
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const web = await context.newPage()
    await confirmOnTheWeb(web, link, () => loginCode !== null)
    for (let i = 0; i < 90 && loginCode === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    // Only once the CLI holds its token: the page is then past the sign-in form.
    if (loginOut.includes(`Logged in to ${API} as`)) {
      await web.screenshot({ path: `${RESULTS}/CLI-02-device-granted.png` })
    }
    await context.close()
    log(`CLI-02 login exit=${loginCode} stdout="${loginOut.trim()}"`)
    expect(loginCode).toBe(0)
    expect(loginOut).toContain(`Logged in to ${API} as`)

    const result = await runCli(['tenant', 'get', '-o', 'json'])
    expect(result.code, result.stderr).toBe(0)
    const fromCli = JSON.parse(result.stdout)
    const fromApi = await get('tenant', '/v1/tenant')
    for (const field of ['id', 'name', 'status', 'maxVms', 'maxNetworks']) {
      expect(fromCli[field], field).toEqual(fromApi[field])
    }
    fs.writeFileSync(`${RESULTS}/cli-tenant-get.txt`, (await runCli(['tenant', 'get'])).stdout)
  })

  // OpenViCloud/titan-cli:command/auth/auth.go newStatus — who, and where
  test('CLI-03 `auth status` names beta-user and this env', async () => {
    const result = await runCli(['auth', 'status', '-o', 'json'])
    log(`CLI-03 exit=${result.code} ${result.stdout.trim()}`)
    expect(result.code).toBe(0)
    const info = JSON.parse(result.stdout)
    expect(info.username).toBe(process.env.BETA_USER_USERNAME || 'beta-user')
    expect(info.api).toBe(API)
  })

  // --- vm ssh: a VM with the tenant's key, reached through the CLI's tunnel ---------------------------------------
  // Key pairs are made in the pod for this run and never leave it. Every attempt that opens a session on a running VM
  // is one vm.ssh_requested row (OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs HandleAsync records
  // it once the guest's SSH server has spoken, before the upgrade; a refusal records nothing).

  // OpenViCloud/titan-cli:command/vm/vm.go SshArgs (ssh's arguments) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs (OpenVmSshEndpoint) ·
  // The bodies of CLI-06..11 live in lib/cli-ssh.ts: cli/edge/cli-edge.spec.ts runs the same chain on the release environment.
  test('CLI-06 `vm ssh` reaches a running VM with the tenant\'s key; known_hosts keeps it under openvicloud-<id>', async () => {
    await chain.cli06()
  })

  test('CLI-07 scp through the tunnel carries 1 MiB each way unchanged', async () => {
    await chain.cli07()
  })

  test('CLI-08 a key the VM does not hold is refused with exit 255 and leaves no process in the guest', async () => {
    await chain.cli08()
  })

  test('CLI-09 the remote command\'s exit code is the CLI\'s exit code', async () => {
    await chain.cli09()
  })

  test('CLI-11 refusals: a plain GET, an unknown VM, a stopped VM; activity counts the sessions opened', async () => {
    await chain.cli11()
  })

  // Last of the chain: if the edge cuts this long session, no later case goes unmeasured.
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ShellRelay.cs ShellRelayOptions.Default (IdleTimeout): only 30 minutes without a byte either way ends a session
  test('CLI-10 a session with no byte for 5 minutes stays open', async () => {
    await chain.startAgainAndReach()
    const started = Date.now()
    const result = await chain.vmSsh('rg-key', 'yes', ['sleep 330; echo alive'])
    const seconds = Math.round((Date.now() - started) / 1000)
    log(`CLI-10 exit=${result.code} stdout="${result.stdout.trim()}" after ${seconds} s`)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('alive')
    expect(seconds).toBeGreaterThanOrEqual(330)
  })

  test.afterAll(async () => {
    await chain.cleanUp()
  })
})

// --- CLI-05: catalog commands, matched field by field against the API they read -------------------------------
// Runs outside the serial VM/ssh chain: a catalog read does not depend on CLI-06..11, and must not be skipped when a
// case of that chain goes red.
test.describe('cli catalog', () => {
  // OpenViCloud/titan-cli:command/catalog/catalog.go NewCluster (cluster list) ·
  // titan-ops architecture/money-and-wallet.md#money-is-long-vnd (the money-of-tenant part
  // of CLI-05 stays NOT COVERED in plan.md: no CLI command reads a tenant's own cost yet)
  test('CLI-05 cluster/template/size list match GET /v1/clusters, /v1/templates, /v1/vm-offerings to every digit', async () => {
    const { clusterId } = await envOf()

    const clusterResult = await runCli(['cluster', 'list', '-o', 'json'])
    expect(clusterResult.code, clusterResult.stderr).toBe(0)
    const clustersFromCli = JSON.parse(clusterResult.stdout) as Array<{ id: string, name: string }>
    const clustersFromApi = await get('anonymous', '/v1/clusters') as Array<{ id: string, name: string }>
    expect(clustersFromCli.map((z) => z.id).sort()).toEqual(clustersFromApi.map((z) => z.id).sort())
    for (const cluster of clustersFromApi) {
      const fromCli = clustersFromCli.find((z) => z.id === cluster.id)
      expect(fromCli, cluster.id).toBeTruthy()
      expect(fromCli!.name).toBe(cluster.name)
    }

    const templateResult = await runCli(['template', 'list', '--cluster', clusterId, '-o', 'json'])
    expect(templateResult.code, templateResult.stderr).toBe(0)
    const templatesFromCli = JSON.parse(templateResult.stdout) as Array<{ id: string, name: string, os: string, diskGb: number }>
    const templatesFromApi = await get('tenant', `/v1/templates?clusterId=${clusterId}`) as Array<{ id: string, name: string, os: string, diskGb: number }>
    expect(templatesFromCli.map((t) => t.id).sort()).toEqual(templatesFromApi.map((t) => t.id).sort())
    for (const template of templatesFromApi) {
      const fromCli = templatesFromCli.find((t) => t.id === template.id)
      expect(fromCli, template.id).toBeTruthy()
      expect(fromCli!.name).toBe(template.name)
      expect(fromCli!.os).toBe(template.os)
      expect(fromCli!.diskGb).toBe(template.diskGb)
    }

    // Prices are `decimal` server-side (OpenViCloud/titan-control-plane:Titan.Application/Queries/Catalog/VmOffering/Contracts/VmOfferingQueryResult.cs VmOfferingQueryResult)
    // and json.Number in the CLI (OpenViCloud/titan-cli:api/client.gen.go VmOfferingQueryResult):
    // both keep every digit on the wire. JSON.parse would renormalize "161388.0000000000" to 161388, so the
    // price is compared as raw text, not parsed.
    const sizeResult = await runCli(['size', 'list', '-o', 'json'])
    expect(sizeResult.code, sizeResult.stderr).toBe(0)
    const sizesFromCli = JSON.parse(sizeResult.stdout) as Array<{ id: string, name: string, vcpu: number, memoryMb: number }>
    const offeringsReply = await call('anonymous', 'GET', '/v1/vm-offerings')
    expectStatus(offeringsReply, 200)
    const offeringsFromApi = bodyOf(offeringsReply) as Array<{ id: string, name: string, vcpu: number, memoryMb: number }>
    expect(sizesFromCli.map((s) => s.id).sort()).toEqual(offeringsFromApi.map((o) => o.id).sort())
    for (const offering of offeringsFromApi) {
      const fromCli = sizesFromCli.find((s) => s.id === offering.id)
      expect(fromCli, offering.id).toBeTruthy()
      expect(fromCli!.name).toBe(offering.name)
      expect(fromCli!.vcpu).toBe(offering.vcpu)
      expect(fromCli!.memoryMb).toBe(offering.memoryMb)
      expect(rawNumberField(sizeResult.stdout, offering.id, 'pricePerHour'))
        .toBe(rawNumberField(offeringsReply.text, offering.id, 'pricePerHour'))
    }

    // The table form: OpenViCloud/titan-cli:command/catalog/catalog.go NewSize (Printer.Table headers ID, NAME, VCPU,
    // MEMORY MB, PRICE/HOUR) · OpenViCloud/titan-cli:output/printer.go (Printer.Table: tabwriter, padding 2, so columns
    // are two or more spaces apart while MEMORY MB holds one).
    const tableResult = await runCli(['size', 'list'])
    expect(tableResult.code, tableResult.stderr).toBe(0)
    const tableLines = tableResult.stdout.split('\n').filter((line) => line.trim() !== '')
    log(`CLI-05 size list table header: ${tableLines[0]}`)
    expect(tableLines[0].trim().split(/\s{2,}/)).toEqual(['ID', 'NAME', 'VCPU', 'MEMORY MB', 'PRICE/HOUR'])
    expect(tableLines.length - 1).toBe(offeringsFromApi.length)
    log(`CLI-05 clusters=${clustersFromApi.length} templates=${templatesFromApi.length} sizes=${offeringsFromApi.length}`)
  })
})

// --- CLI-12..17: ssh-key + VM lifecycle commands, on the run's network ------------------------------------------
// A separate key pair and ssh directory from CLI-06..11's: registering the same public key twice is 409
// SSH_KEY_EXISTS, and the chain's vmSsh()/scp() count attempts that CLI-11 already checked against the activity feed.
test.describe.serial('cli lifecycle', () => {
  test.describe.configure({ timeout: 25 * 60_000 })

  const LIFECYCLE_SSH_DIR = '/work/ssh-cli-lifecycle'
  const KEY_NAME = `rg-cli-${RUN}`
  const VM2_NAME = `rg-vmcli2-${RUN}`
  const VM3_NAME = `rg-vmcli3-${RUN}`
  let lifecycleKeyId = ''
  let lifecycleVmId = ''
  let extraVmId = ''

  test.afterAll(async () => {
    const steps: Array<[string, () => Promise<void>]> = []
    if (extraVmId !== '') {
      steps.push([`delete VM ${extraVmId}`, () => deleteVmAndWait(extraVmId)])
    }
    if (lifecycleVmId !== '') {
      steps.push([`delete VM ${lifecycleVmId}`, () => deleteVmAndWait(lifecycleVmId)])
    }
    if (lifecycleKeyId !== '') {
      steps.push([`delete SSH key ${lifecycleKeyId}`, async () => {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${lifecycleKeyId}`), 204)
      }])
    }
    await cleanUp(steps)
  })

  // OpenViCloud/titan-cli:command/sshkey/sshkey.go newAdd (add), newList (list) · titan-ops features/vm/design.md#ssh-key
  test('CLI-12 `ssh-key add` then `ssh-key list` shows the fingerprint ssh-keygen computes for the same file', async () => {
    fs.rmSync(LIFECYCLE_SSH_DIR, { recursive: true, force: true })
    fs.mkdirSync(LIFECYCLE_SSH_DIR, { recursive: true })
    const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_NAME, '-f', `${LIFECYCLE_SSH_DIR}/key`])
    expect(made.code, made.stderr).toBe(0)

    const added = await runCli(['ssh-key', 'add', KEY_NAME, '--public-key-file', `${LIFECYCLE_SSH_DIR}/key.pub`])
    log(`CLI-12 add exit=${added.code} ${added.stdout.trim()}`)
    expect(added.code, added.stderr).toBe(0)
    expect(added.stdout).toMatch(/ID:/)

    const keygen = await run('ssh-keygen', ['-lf', `${LIFECYCLE_SSH_DIR}/key.pub`])
    expect(keygen.code, keygen.stderr).toBe(0)
    const expectedFingerprint = keygen.stdout.trim().split(' ')[1]

    const listed = await runCli(['ssh-key', 'list', '-o', 'json'])
    expect(listed.code, listed.stderr).toBe(0)
    const keys = JSON.parse(listed.stdout) as Array<{ id: string, name: string, fingerprint: string }>
    const key = keys.find((k) => k.name === KEY_NAME)
    expect(key, `${KEY_NAME} in ${listed.stdout}`).toBeTruthy()
    lifecycleKeyId = key!.id
    log(`CLI-12 fingerprint cli=${key!.fingerprint} ssh-keygen=${expectedFingerprint}`)
    expect(key!.fingerprint).toBe(expectedFingerprint)
    expect(key!.fingerprint).toMatch(/^SHA256:/)
  })

  // OpenViCloud/titan-cli:command/vm/lifecycle.go newCreate, waitFor (create --wait) ·
  // OpenViCloud/titan-cli:command/vm/vm.go resolve (ssh by name) — create by name, size m, then log in
  test('CLI-13 `vm create --wait` reaches Running/Ready and matches the API; `vm ssh … id -un` prints ubuntu', async () => {
    // create --wait (up to 10 minutes) and the guest start wait (GUEST_START_WAIT_MS) in one test
    test.setTimeout(25 * 60_000)
    const { clusterId, templateId } = await envOf()
    const network = await runNetwork()
    const templates = await get('tenant', `/v1/templates?clusterId=${clusterId}`) as Array<{ id: string, name: string }>
    const template = templates.find((t) => t.id === templateId)
    expect(template, `template ${templateId} must still be listed in cluster ${clusterId}`).toBeTruthy()
    const templateName = template!.name

    const created = await runCli(['vm', 'create', VM2_NAME, '--cluster', clusterId, '--network', network.name,
      '--template', templateName, '--size', 'm', '--ssh-key', KEY_NAME, '--wait', '--timeout', '10m'])
    log(`CLI-13 create exit=${created.code} stdout="${created.stdout.trim()}" stderr="${created.stderr.trim()}"`)
    expect(created.code, created.stderr).toBe(0)
    expect(created.stdout).toMatch(/Status:\s+(Running|Ready)\s*$/m)

    const idMatch = created.stdout.match(/^ID:\s+(\S+)/m)
    expect(idMatch, created.stdout).not.toBeNull()
    lifecycleVmId = idMatch![1]
    const fromApi = await getVm(lifecycleVmId)
    log(`CLI-13 api ${vmShape(fromApi)}`)
    expect(['Running', 'Ready']).toContain(fromApi.status)

    const result = await untilGuestAnswers('CLI-13 ssh', () =>
      runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key', 'accept-new'), 'id', '-un']))
    log(`CLI-13 ssh exit=${result.code} stdout="${result.stdout.trim()}"`)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('ubuntu')
  })

  // OpenViCloud/titan-cli:command/vm/lifecycle.go newRequest (newStop/newStart share newRequest, both take --wait)
  test('CLI-14 `vm stop --wait` then `vm start --wait` report Stopped, then Running/Ready', async () => {
    test.setTimeout(10 * 60_000)
    const stopped = await runCli(['vm', 'stop', VM2_NAME, '--wait'])
    log(`CLI-14 stop exit=${stopped.code} stdout="${stopped.stdout.trim()}"`)
    expect(stopped.code, stopped.stderr).toBe(0)
    expect(stopped.stdout).toMatch(/Status:\s+Stopped\s*$/m)

    const started = await runCli(['vm', 'start', VM2_NAME, '--wait'])
    log(`CLI-14 start exit=${started.code} stdout="${started.stdout.trim()}"`)
    expect(started.code, started.stderr).toBe(0)
    expect(started.stdout).toMatch(/Status:\s+(Running|Ready)\s*$/m)
  })

  // OpenViCloud/titan-cli:command/vm/lifecycle.go newCreate (resolveNetwork/createVm — client-side resolution before any POST) ·
  // titan-ops features/cli/design.md#error-codes. Runs before CLI-15 renames/deletes VM2_NAME: the taken-name case
  // needs a live VM holding that name.
  test('CLI-16 create refuses an unknown network with no new VM, and a taken name with (VM_NAME_TAKEN)', async () => {
    const { clusterId, templateId } = await envOf()
    const beforeVms = await get('tenant', '/v1/tenant/vms') as Array<{ id: string }>
    const noNetwork = await runCli(['vm', 'create', `rg-vmcli-bad-${RUN}`, '--cluster', clusterId, '--network', `rg-nope-${RUN}`,
      '--template', templateId, '--size', 'm', '--wait'])
    log(`CLI-16 no-network exit=${noNetwork.code} stderr="${noNetwork.stderr.trim()}"`)
    expect(noNetwork.code).not.toBe(0)
    expect(noNetwork.stderr).toMatch(/no network named/)
    const afterVms = await get('tenant', '/v1/tenant/vms') as Array<{ id: string }>
    expect(afterVms.map((v) => v.id).sort()).toEqual(beforeVms.map((v) => v.id).sort())

    const network = await runNetwork()
    const taken = await runCli(['vm', 'create', VM2_NAME, '--cluster', clusterId, '--network', network.name,
      '--template', templateId, '--size', 'm'])
    log(`CLI-16 taken-name exit=${taken.code} stderr="${taken.stderr.trim()}"`)
    expect(taken.code).not.toBe(0)
    expect(taken.stderr).toContain('(VM_NAME_TAKEN)')
    // Belt and braces: if the server somehow accepted it, the extra VM still gets cleaned up.
    if (taken.code === 0) {
      const match = taken.stdout.match(/^ID:\s+(\S+)/m)
      if (match !== null) {
        extraVmId = match[1]
      }
    }
  })

  // OpenViCloud/titan-cli:command/vm/lifecycle.go newRename (rename), newRequest (delete's confirm prompt and --yes)
  test('CLI-15 rename, decline delete, then `--yes --wait` deletes and the API shows status Deleted', async () => {
    test.setTimeout(10 * 60_000)
    const renamed = await runCli(['vm', 'rename', VM2_NAME, VM3_NAME])
    log(`CLI-15 rename exit=${renamed.code} stderr="${renamed.stderr.trim()}"`)
    expect(renamed.code, renamed.stderr).toBe(0)
    // newRename only calls deps.Printer.Message, which writes to Err (OpenViCloud/titan-cli:output/printer.go Printer.Message), not Out.
    expect(renamed.stderr).toMatch(/renamed to/)
    const got = await runCli(['vm', 'get', VM3_NAME, '-o', 'json'])
    expect(got.code, got.stderr).toBe(0)
    expect(JSON.parse(got.stdout).name).toBe(VM3_NAME)

    const declined = await runWithStdin(['vm', 'delete', VM3_NAME], 'n\n')
    log(`CLI-15 decline exit=${declined.code} stderr="${declined.stderr.trim()}"`)
    expect(declined.code).not.toBe(0)
    expect(declined.stderr).toMatch(/not deleted/)
    const stillThere = await getVm(lifecycleVmId)
    expect(stillThere.status).not.toBe('Deleted')

    const deletedResult = await runCli(['vm', 'delete', VM3_NAME, '--yes', '--wait'])
    log(`CLI-15 delete exit=${deletedResult.code} stderr="${deletedResult.stderr.trim()}"`)
    expect(deletedResult.code, deletedResult.stderr).toBe(0)
    // The delete branch of newRequest only calls deps.Printer.Message("VM %s deleted.", …), to Err.
    expect(deletedResult.stderr).toMatch(/deleted/)
    const fromApi = await getVm(lifecycleVmId)
    log(`CLI-15 api ${vmShape(fromApi)}`)
    expect(fromApi.status).toBe('Deleted')
    lifecycleVmId = '' // afterAll's deleteVmAndWait is a no-op on an already-Deleted VM; clearing it just skips the read.
  })

  // OpenViCloud/titan-cli:command/sshkey/sshkey.go newDelete (delete --yes)
  test('CLI-17 `ssh-key delete --yes` removes the key from `ssh-key list`', async () => {
    const deletedResult = await runCli(['ssh-key', 'delete', KEY_NAME, '--yes'])
    log(`CLI-17 exit=${deletedResult.code} stderr="${deletedResult.stderr.trim()}"`)
    expect(deletedResult.code, deletedResult.stderr).toBe(0)
    // newDelete only calls deps.Printer.Message("SSH key %s deleted.", …), to Err.
    expect(deletedResult.stderr).toMatch(/deleted/)
    const listed = await runCli(['ssh-key', 'list', '-o', 'json'])
    expect(listed.code, listed.stderr).toBe(0)
    const names = (JSON.parse(listed.stdout) as Array<{ name: string }>).map((k) => k.name)
    expect(names).not.toContain(KEY_NAME)
    lifecycleKeyId = '' // deleted here; afterAll's DELETE would otherwise 404 on a second run after a mid-test failure.
  })
})

// Its own config dir, so no login session can answer in the token's place; the token is made through the API and
// deleted in afterAll. The secret goes to the CLI by environment only, never into the log.
test.describe.serial('cli api token', () => {
  const emptyHome = '/work/cli-home-token'
  const secret = newSecret()
  let tokenId = ''

  function runWithToken(token: string, args: string[]): Promise<CliResult> {
    return new Promise((resolve) => {
      const child = spawn(BINARY, args, { env: { ...cliEnv(), XDG_CONFIG_HOME: emptyHome, OPENVICLOUD_TOKEN: token } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.on('close', (code) => {
        let exit = -1
        if (code !== null) {
          exit = code
        }
        resolve({ code: exit, stdout, stderr })
      })
    })
  }

  test.afterAll(async () => {
    if (tokenId !== '') {
      const deleted = await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${tokenId}`)
      expect([204, 404], `${deleted.url} → ${deleted.text.slice(0, 200)}`).toContain(deleted.status)
    }
  })

  // OpenViCloud/titan-cli:command/root.go (Deps.ApiToken, ApiTokenFromEnv: OPENVICLOUD_TOKEN replaces the session);
  // OpenViCloud/titan-cli:output/problem.go Explain (401 with SentApiToken names OPENVICLOUD_TOKEN) · titan-ops features/cli/design.md#api-token
  test('CLI-18 OPENVICLOUD_TOKEN with no session: tenant get and vm list work; an unknown token names OPENVICLOUD_TOKEN, not auth login', async () => {
    fs.rmSync(emptyHome, { recursive: true, force: true })
    fs.mkdirSync(emptyHome, { recursive: true })
    const created = await call('tenant', 'POST', '/v1/tenant/api-tokens', { name: `rg-tok-cli-${RUN}`, token: secret, expiresInDays: 30 }, newKey())
    expectStatus(created, 201)
    tokenId = bodyOf(created).apiTokenId

    const tenant = await runWithToken(secret, ['tenant', 'get', '-o', 'json'])
    expect(tenant.code, tenant.stderr).toBe(0)
    const fromCli = JSON.parse(tenant.stdout)
    const fromApi = await get('tenant', '/v1/tenant')
    for (const field of ['id', 'name', 'status', 'maxVms', 'maxNetworks']) {
      expect(fromCli[field], field).toEqual(fromApi[field])
    }
    const vms = await runWithToken(secret, ['vm', 'list'])
    expect(vms.code, vms.stderr).toBe(0)
    const unknown = await runWithToken(newSecret(), ['vm', 'list'])
    log(`CLI-18 tenant get exit=${tenant.code} vm list exit=${vms.code} unknown token exit=${unknown.code} stderr="${unknown.stderr.trim()}"`)
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain('OPENVICLOUD_TOKEN')
    expect(unknown.stderr).not.toContain('auth login')
  })
})

// CLI-04 is last and on its own: it logs the CLI out, so nothing after it in this file may assume a session.
test.describe('cli logout', () => {
  // OpenViCloud/titan-cli:command/auth/auth.go newLogout (logout), OpenViCloud/titan-cli:command/root.go Deps.explainSession (not logged in):
  // a sentence, exit ≠ 0
  test('CLI-04 after logout, `tenant get` fails with a readable sentence and a non-zero exit', async () => {
    const logout = await runCli(['auth', 'logout'])
    expect(logout.code).toBe(0)
    expect(logout.stdout).toContain('Logged out.')
    const result = await runCli(['tenant', 'get'])
    log(`CLI-04 exit=${result.code} stderr="${result.stderr.trim()}"`)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/not logged in/i)
    expect(result.stderr).not.toMatch(/panic|goroutine|\{"/)
  })
})
