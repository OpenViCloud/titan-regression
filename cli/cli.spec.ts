import { test, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { PORTAL, closeSessions, useBrowser } from './auth'
import { startLocalProxyIfNeeded } from './local-proxy'
import { API, RESULTS, bodyOf, call, expectStatus, get, log, newKey, sleep, startLog } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, vmShape, waitVm } from './fixtures'
import { cleanUp } from './clean-up'
import { newSecret } from './token'
import { incusName } from './incus-names'
import { BINARY, CLI_HOME, CliSshChain, type CliResult, cliAuthUrl, cliEnv, run, runCli, runWithStdin, setCliAuthUrl,
  sshOptions, untilGuestAnswers, waitForBinary } from './cli-ssh'

// Cases CLI-01..18, CLI-20, CLI-21 of plan.md, in five describes that run in this order: 'cli' (CLI-01..03, CLI-06..11),
// 'cli catalog' (CLI-05), 'cli lifecycle' (CLI-12..17, CLI-20, CLI-21), 'cli api token' (CLI-18), 'cli logout' (CLI-04). The binary is not in the image: when
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
// would not preserve (it normalizes "1.50" to 1.5). Both sides are read as text, never parsed.
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
    // both keep every digit on the wire. JSON.parse would renormalize "1.50" to 1.5, so the
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

// --- CLI-12..17, CLI-20, CLI-21: ssh-key + VM lifecycle commands, on the run's network -------------------------
// A separate key pair and ssh directory from CLI-06..11's: registering the same public key twice is 409
// SSH_KEY_EXISTS, and the chain counts the sessions it opened, which CLI-11 already checked against the activity feed.
// Order: CLI-12, CLI-13, CLI-14, CLI-13's ssh, CLI-16, CLI-21, CLI-15, CLI-20, CLI-17. Dev's Incus host has 4 GiB, so
// one VM of this describe runs at a time: CLI-06..11's VM is deleted in the 'cli' describe's afterAll, and CLI-20's
// starts only after CLI-15 deleted CLI-13's.

// `vm stop <name> --wait` with the spec's clock around it. The two marks and the instance name are what the agent reads
// the worker log by: `kubectl logs … --since-time=<from>`, lines whose `object` is the instance
// (OpenViCloud/titan-incus-worker:resource/vm/action.go Action.Run logs "the guest did not shut down; powering off").
// toISOString() is RFC 3339 in UTC.
async function timedStop(caseId: string, vmId: string, vmName: string): Promise<{ result: CliResult, ms: number }> {
  const instance = incusName('vm', vmId)
  const from = new Date()
  log(`${caseId} stop from=${from.toISOString()} instance=${instance}`)
  const result = await runCli(['vm', 'stop', vmName, '--wait'])
  const to = new Date()
  const ms = to.getTime() - from.getTime()
  log(`${caseId} stop to=${to.toISOString()} instance=${instance} seconds=${(ms / 1000).toFixed(1)} exit=${result.code} ` +
    `stdout="${result.stdout.trim()}" stderr="${result.stderr.trim()}"`)
  return { result, ms }
}

// Like runWithStdin() of lib/cli-ssh.ts, but stdin is a file (the shell's `< <file>`), so the CLI reads it to its end.
function runWithStdinFrom(args: string[], path: string): Promise<CliResult> {
  const fd = fs.openSync(path, 'r')
  return new Promise((resolve) => {
    const child = spawn(BINARY, args, { env: cliEnv(), stdio: [fd, 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('close', (code) => {
      fs.closeSync(fd)
      let exit = -1
      if (code !== null) {
        exit = code
      }
      resolve({ code: exit, stdout, stderr })
    })
  })
}

// A VM waiting on a create, start, stop or snapshot refuses a delete
// (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Deletion.cs Vm.Delete): wait until it is at rest first.
async function deleteOnceSettled(label: string, vmId: string): Promise<void> {
  const waiting = ['Creating', 'Starting', 'Stopping', 'Snapshotting']
  const vm = await waitVm(`${label} settled`, vmId, (v) => !waiting.includes(v.status))
  if (vm.status === 'Deleting') {
    await waitVm(`${label} deleted`, vmId, (v) => v.status === 'Deleted')
    return
  }
  await deleteVmAndWait(vmId)
}

test.describe.serial('cli lifecycle', () => {
  test.describe.configure({ timeout: 25 * 60_000 })

  const LIFECYCLE_SSH_DIR = '/work/ssh-cli-lifecycle'
  const CONSOLE_PASSWORD_DIR = '/work/cli-console-password'
  const KEY_NAME = `rg-cli-${RUN}`
  const VM2_NAME = `rg-vmcli2-${RUN}`
  const VM3_NAME = `rg-vmcli3-${RUN}`
  const VM4_NAME = `rg-vmcli4-${RUN}`
  const VM5_NAME = `rg-vmcli5-${RUN}`
  const HOST_KEYS = ['/etc/ssh/ssh_host_rsa_key', '/etc/ssh/ssh_host_ecdsa_key', '/etc/ssh/ssh_host_ed25519_key']
  let lifecycleKeyId = ''
  let lifecycleVmId = ''
  let extraVmId = ''
  let consoleVmId = ''
  // CLI-13's `vm ssh … id -un`: its first run is CLI-14's wait for the guest after the stop and start.
  let cli13Ssh: CliResult | null = null
  // CLI-21 measured a stop of 30 s or more: the 5-minute part of CLI-15's delete is measured only then.
  let cli21Measured = false
  // CLI-23: the user data file of CLI-20's first create, and what the API read back for that VM.
  const USER_DATA_DIR = '/work/cli-user-data'
  const VM6_NAME = `rg-vmcli6-${RUN}`
  const CLI23_USER_DATA = `#cloud-config\n# rg-${RUN} ✓ tiếng Việt\n`
  let cli23UserData: string | null = null

  test.afterAll(async () => {
    fs.rmSync(CONSOLE_PASSWORD_DIR, { recursive: true, force: true })
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
    const steps: Array<[string, () => Promise<void>]> = []
    if (extraVmId !== '') {
      steps.push([`delete VM ${extraVmId}`, () => deleteVmAndWait(extraVmId)])
    }
    if (consoleVmId !== '') {
      steps.push([`delete VM ${consoleVmId}`, () => deleteOnceSettled('afterAll console VM', consoleVmId)])
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

  // OpenViCloud/titan-cli:command/vm/lifecycle.go newCreate, waitFor (create --wait) — create by name, size m. Its
  // `vm ssh … id -un` runs after CLI-14, which must stop the VM before any SSH session.
  test('CLI-13 `vm create --wait` reaches Running/Ready and matches the API', async () => {
    test.setTimeout(15 * 60_000)
    const { clusterId, templateId } = await envOf()
    const network = await runNetwork()
    const templates = await get('tenant', `/v1/templates?clusterId=${clusterId}`) as Array<{ id: string, name: string }>
    const template = templates.find((t) => t.id === templateId)
    expect(template, `template ${templateId} must still be listed in cluster ${clusterId}`).toBeTruthy()
    const templateName = template!.name

    const created = await runCli(['vm', 'create', VM2_NAME, '--cluster', clusterId, '--network', network.name,
      '--template', templateName, '--size', 'm', '--ssh-key', KEY_NAME, '--wait', '--timeout', '10m'])
    log(`CLI-13 create exit=${created.code} stdout="${created.stdout.trim()}" stderr="${created.stderr.trim()}"`)
    const idMatch = created.stdout.match(/^ID:\s+(\S+)/m)
    if (idMatch !== null) {
      lifecycleVmId = idMatch[1]
    }
    expect(created.code, created.stderr).toBe(0)
    expect(created.stdout).toMatch(/Status:\s+(Running|Ready)\s*$/m)
    expect(idMatch, created.stdout).not.toBeNull()
    const fromApi = await getVm(lifecycleVmId)
    log(`CLI-13 api ${vmShape(fromApi)}`)
    expect(['Running', 'Ready']).toContain(fromApi.status)
  })

  // OpenViCloud/titan-cli:command/vm/lifecycle.go newStop, newStart, waitFor (stop/start --wait) ·
  // titan-ops features/vm/design.md#vm-stop-timeout · OpenViCloud/titan-incus-worker:resource/vm/action.go (Action.Run,
  // isShutdownNotDone). A stop right after create catches the guest mid-boot, before cloud-init has its host keys on
  // disk; whether the worker powered it off (default stop timeout 120 s) is the agent's read of the worker log between
  // the two marks timedStop() logs. Either way the host keys must survive.
  test('CLI-14 stop at once after create, then start: `vm ssh` gets in and the three host keys are not empty', async () => {
    test.setTimeout(25 * 60_000)
    expect(lifecycleVmId, 'CLI-13 made the VM').not.toBe('')
    const { result: stopped } = await timedStop('CLI-14', lifecycleVmId, VM2_NAME)
    expect(stopped.code, stopped.stderr).toBe(0)
    expect(stopped.stdout).toMatch(/Status:\s+Stopped\s*$/m)

    const started = await runCli(['vm', 'start', VM2_NAME, '--wait'])
    log(`CLI-14 start exit=${started.code} stdout="${started.stdout.trim()}"`)
    expect(started.code, started.stderr).toBe(0)
    expect(started.stdout).toMatch(/Status:\s+(Running|Ready)\s*$/m)

    // CLI-13's ssh, every 10 s for up to 10 minutes (GUEST_START_WAIT_MS of lib/ssh.ts)
    const firstIn = Date.now()
    cli13Ssh = await untilGuestAnswers('CLI-14 ssh', () =>
      runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key', 'accept-new'), 'id', '-un']))
    log(`CLI-14 ssh exit=${cli13Ssh.code} stdout="${cli13Ssh.stdout.trim()}" after ${Math.round((Date.now() - firstIn) / 1000)} s`)
    expect(cli13Ssh.code, cli13Ssh.stderr).toBe(0)
    expect(cli13Ssh.stdout.trim()).toBe('ubuntu')

    const stat = await runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key', 'yes'),
      `sudo stat -c '%s %n' ${HOST_KEYS.join(' ')}`])
    log(`CLI-14 host keys exit=${stat.code} stdout="${stat.stdout.trim()}" stderr="${stat.stderr.trim()}"`)
    expect(stat.code, stat.stderr).toBe(0)
    const lines = stat.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    for (const key of HOST_KEYS) {
      const line = lines.find((l) => l.endsWith(` ${key}`))
      expect(line, `${key} in ${stat.stdout}`).toBeTruthy()
      expect(Number(line!.split(' ')[0]), key).toBeGreaterThan(0)
    }
  })

  // OpenViCloud/titan-cli:command/vm/vm.go resolve (ssh by name). The ssh itself ran once, in CLI-14: the plan has
  // CLI-13's first `vm ssh … id -un` after the stop and start, and CLI-14's wait for the guest is that command.
  test('CLI-13 `vm ssh … id -un`, first run after the stop and start, prints ubuntu', async () => {
    expect(cli13Ssh, 'CLI-14 ran CLI-13\'s ssh').not.toBeNull()
    expect(cli13Ssh!.code, cli13Ssh!.stderr).toBe(0)
    expect(cli13Ssh!.stdout.trim()).toBe('ubuntu')
  })

  // titan-ops features/vm/user-stories.md#us-vm-add-key AC-1, AC-3, AC-8 · titan-ops features/vm/design.md#vm-key-addition ·
  // OpenViCloud/titan-cli:command/vm/addsshkey.go (newAddSshKey: the waiting line and the missing --ssh-key error before any
  // request, by Printer.Message to stderr; printKeyAddition: the fields to stdout, the restart line only when restartNeeded) ·
  // OpenViCloud/titan-incus-worker:resource/vmkeyaddition/create.go (appends only a line the file lacks). After CLI-14, so
  // VM2_NAME runs and `vm ssh` with the run's key gets in; before CLI-21 stops it again.
  test('CLI-22 `vm add-ssh-key` adds a second key that logs in at once; the same key again adds no line; no --ssh-key is refused', async () => {
    test.setTimeout(15 * 60_000)
    expect(lifecycleVmId, 'CLI-13 made the VM').not.toBe('')
    const key2Name = `rg-cli2-${RUN}`
    const additions = async (): Promise<number> => (await get('tenant', `/v1/tenant/vms/${lifecycleVmId}/key-additions`) as any[]).length
    const lines = async (): Promise<CliResult> =>
      runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key', 'yes'), 'sudo', 'wc', '-l', '/etc/ssh/openvicloud/ubuntu'])
    const countOfLines = (result: CliResult): number => Number(result.stdout.trim().split(/\s+/)[0])
    try {
      fs.rmSync(`${LIFECYCLE_SSH_DIR}/key2`, { force: true })
      fs.rmSync(`${LIFECYCLE_SSH_DIR}/key2.pub`, { force: true })
      const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', key2Name, '-f', `${LIFECYCLE_SSH_DIR}/key2`])
      expect(made.code, made.stderr).toBe(0)
      const saved = await runCli(['ssh-key', 'add', key2Name, '--public-key-file', `${LIFECYCLE_SSH_DIR}/key2.pub`])
      log(`CLI-22 ssh-key add exit=${saved.code} ${saved.stdout.trim()}`)
      expect(saved.code, saved.stderr).toBe(0)

      const added = await runCli(['vm', 'add-ssh-key', VM2_NAME, '--ssh-key', key2Name])
      log(`CLI-22 add exit=${added.code} stdout="${added.stdout.trim()}" stderr="${added.stderr.trim()}"`)
      expect(added.code, added.stderr).toBe(0)
      expect(added.stderr).toContain(`Adding 1 SSH key(s) to VM ${VM2_NAME}, waiting until it is Added or Failed...`)
      expect(added.stdout).toMatch(/^Status:\s+Added\s*$/m)
      expect(added.stdout).toMatch(/^Restart needed:\s+false\s*$/m)
      expect(added.stderr).not.toMatch(/Stop VM .* and start it again/)

      const withKey2 = await runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key2', 'yes'), 'id', '-un'])
      log(`CLI-22 ssh with the added key exit=${withKey2.code} stdout="${withKey2.stdout.trim()}" stderr="${withKey2.stderr.trim()}"`)
      expect(withKey2.code, withKey2.stderr).toBe(0)
      expect(withKey2.stdout.trim()).toBe('ubuntu')
      const withRunKey = await runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key', 'yes'), 'id', '-un'])
      log(`CLI-22 ssh with the run's key exit=${withRunKey.code} stdout="${withRunKey.stdout.trim()}"`)
      expect(withRunKey.code, withRunKey.stderr).toBe(0)
      expect(withRunKey.stdout.trim()).toBe('ubuntu')

      const before = await lines()
      log(`CLI-22 key file before the repeat exit=${before.code} "${before.stdout.trim()}"`)
      expect(before.code, before.stderr).toBe(0)
      expect(countOfLines(before)).toBe(2)
      const again = await runCli(['vm', 'add-ssh-key', VM2_NAME, '--ssh-key', key2Name])
      log(`CLI-22 repeat exit=${again.code} stdout="${again.stdout.trim()}"`)
      expect(again.code, again.stderr).toBe(0)
      expect(again.stdout).toMatch(/^Status:\s+Added\s*$/m)
      const after = await lines()
      log(`CLI-22 key file after the repeat exit=${after.code} "${after.stdout.trim()}"`)
      expect(after.code, after.stderr).toBe(0)
      expect(countOfLines(after)).toBe(2)

      const rows = await additions()
      const none = await runCli(['vm', 'add-ssh-key', VM2_NAME])
      log(`CLI-22 no --ssh-key exit=${none.code} stderr="${none.stderr.trim()}"`)
      expect(none.code).not.toBe(0)
      expect(none.stderr).toContain('at least one --ssh-key is required')
      expect(await additions(), 'no addition from the refused call').toBe(rows)
    } finally {
      await cleanUp([[`delete SSH key ${key2Name}`, async () => {
        for (const key of (await get('tenant', '/v1/tenant/ssh-keys') as any[]).filter((k) => k.name === key2Name)) {
          expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${key.id}`), 204)
        }
      }]])
    }
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

  // titan-ops features/vm/design.md#vm-stop-timeout · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/UpdateVmValidator.cs
  // (UpdateVmValidator: 30..1800) · OpenViCloud/titan-incus-worker:resource/vm/action.go (Action.Run, isShutdownNotDone) ·
  // OpenViCloud/titan-cli:command/vm/lifecycle.go (newStop, waitFor). A guest that ignores the ACPI power button makes
  // the worker wait the VM's 30 s, then power it off. The power-off line in the worker log is the agent's read, not
  // this spec's: the spec logs the two marks and the instance name. Not measured: whether the guest also ignores Incus's
  // shutdown signal (QMP system_powerdown) because of that file.
  test('CLI-21 a guest that ignores the power button: `vm stop --wait` takes the 30 s stop timeout, the drop-in survives', async () => {
    test.setTimeout(25 * 60_000)
    expect(lifecycleVmId, 'CLI-13 made the VM').not.toBe('')
    expectStatus(await call('tenant', 'PATCH', `/v1/tenant/vms/${lifecycleVmId}`, { stopTimeoutSeconds: 30 }), 204)
    expect((await getVm(lifecycleVmId)).stopTimeoutSeconds).toBe(30)

    const ssh = sshOptions(LIFECYCLE_SSH_DIR, 'key', 'yes')
    const ignore = await runCli(['vm', 'ssh', VM2_NAME, '--', ...ssh,
      'sudo mkdir -p /etc/systemd/logind.conf.d' +
      ' && printf \'[Login]\\nHandlePowerKey=ignore\\n\' | sudo tee /etc/systemd/logind.conf.d/rg-ignore-power.conf' +
      ' && sudo systemctl restart systemd-logind'])
    log(`CLI-21 drop-in exit=${ignore.code} stdout="${ignore.stdout.trim()}" stderr="${ignore.stderr.trim()}"`)
    expect(ignore.code, ignore.stderr).toBe(0)
    const synced = await runCli(['vm', 'ssh', VM2_NAME, '--', ...ssh, 'sync'])
    log(`CLI-21 sync exit=${synced.code}`)
    expect(synced.code, synced.stderr).toBe(0)

    const { result: stopped, ms } = await timedStop('CLI-21', lifecycleVmId, VM2_NAME)
    expect(stopped.code, stopped.stderr).toBe(0)
    expect(stopped.stdout).toMatch(/Status:\s+Stopped\s*$/m)

    const started = await runCli(['vm', 'start', VM2_NAME, '--wait'])
    log(`CLI-21 start exit=${started.code} stdout="${started.stdout.trim()}"`)
    expect(started.code, started.stderr).toBe(0)
    expect(started.stdout).toMatch(/Status:\s+(Running|Ready)\s*$/m)
    // Every 10 s for up to 10 minutes, as CLI-14 (GUEST_START_WAIT_MS of lib/ssh.ts)
    const config = await untilGuestAnswers('CLI-21 cat-config', () =>
      runCli(['vm', 'ssh', VM2_NAME, '--', ...ssh, 'systemd-analyze', 'cat-config', 'systemd/logind.conf']))
    log(`CLI-21 cat-config exit=${config.code} HandlePowerKey lines=${JSON.stringify(config.stdout.split('\n').filter((l) => l.includes('HandlePowerKey')))}`)
    expect(config.code, config.stderr).toBe(0)
    expect(config.stdout).toMatch(/^HandlePowerKey=ignore\s*$/m)

    // CLI-15 deletes this VM next: a delete does not read the stop timeout.
    expectStatus(await call('tenant', 'PATCH', `/v1/tenant/vms/${lifecycleVmId}`, { stopTimeoutSeconds: 1800 }), 204)
    expect((await getVm(lifecycleVmId)).stopTimeoutSeconds).toBe(1800)

    const seconds = (ms / 1000).toFixed(1)
    test.skip(ms < 30_000, `N/A: vm stop took ${seconds} s, under the 30 s stop timeout — the guest shut down cleanly`)
    log(`CLI-21 stop took ${seconds} s (>= 30 s)`)
    cli21Measured = true
  })

  // OpenViCloud/titan-cli:command/vm/lifecycle.go newRename (rename), newRequest (delete's confirm prompt and --yes) ·
  // titan-ops architecture/http-contract.md#async-polling-contract · titan-ops features/vm/design.md#vm-stop-timeout ·
  // OpenViCloud/titan-incus-worker:resource/vm/delete.go (removeInstance, forceStopTimeoutSeconds): a delete powers the
  // VM off at once, so CLI-21's 1800 s and the guest that ignores the power button do not hold it up.
  test('CLI-15 rename, decline delete, then `--yes --wait` deletes within 5 minutes and the API shows status Deleted', async () => {
    test.setTimeout(15 * 60_000)
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

    const deleteFrom = Date.now()
    const deletedResult = await runCli(['vm', 'delete', VM3_NAME, '--yes', '--wait'])
    const deleteSeconds = Math.round((Date.now() - deleteFrom) / 1000)
    log(`CLI-15 delete exit=${deletedResult.code} after ${deleteSeconds} s stderr="${deletedResult.stderr.trim()}"`)
    expect(deletedResult.code, deletedResult.stderr).toBe(0)
    // The delete branch of newRequest only calls deps.Printer.Message("VM %s deleted.", …), to Err.
    expect(deletedResult.stderr).toMatch(/deleted/)
    const fromApi = await getVm(lifecycleVmId)
    log(`CLI-15 api ${vmShape(fromApi)}`)
    expect(fromApi.status).toBe('Deleted')
    lifecycleVmId = '' // afterAll's deleteVmAndWait is a no-op on an already-Deleted VM; clearing it just skips the read.
    if (cli21Measured) {
      expect(deleteSeconds, 'a delete does not wait the VM\'s 1800 s stop timeout').toBeLessThanOrEqual(300)
    } else {
      log(`CLI-15 N/A for the 5-minute part: CLI-21 was N/A (delete took ${deleteSeconds} s)`)
      test.info().annotations.push({ type: 'N/A', description: 'the 5-minute part of the delete: CLI-21 was N/A' })
    }
  })

  // titan-ops features/cli/design.md#vm-lifecycle · OpenViCloud/titan-cli:command/vm/lifecycle.go (readConsolePassword:
  // stdin less one line end, empty refused before any request; newCreate registers no flag that takes the password
  // on the command line). Runs after CLI-15 deleted CLI-13's VM: one VM of this describe at a time.
  test('CLI-20 `vm create --console-password-stdin` reads the password from stdin only and never prints it', async () => {
    test.setTimeout(25 * 60_000)
    const { clusterId, templateId } = await envOf()
    const network = await runNetwork()
    const password = crypto.randomBytes(12).toString('base64url')
    expect(password.length).toBe(16)
    const hide = (text: string): string => text.split(password).join('***').trim()
    fs.rmSync(CONSOLE_PASSWORD_DIR, { recursive: true, force: true })
    fs.mkdirSync(CONSOLE_PASSWORD_DIR, { recursive: true, mode: 0o700 })
    const passwordFile = `${CONSOLE_PASSWORD_DIR}/password`
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 })
    const createArgs = (name: string): string[] => ['vm', 'create', name, '--cluster', clusterId, '--network', network.name,
      '--template', templateId, '--size', 'm']
    try {
      // CLI-23's first part rides this create: its user data file, read back from the API before the delete below.
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
      fs.mkdirSync(USER_DATA_DIR, { recursive: true })
      fs.writeFileSync(`${USER_DATA_DIR}/user-data`, CLI23_USER_DATA)
      const created = await runWithStdinFrom([...createArgs(VM4_NAME), '--console-password-stdin', '--user-data', `${USER_DATA_DIR}/user-data`,
        '--wait', '--timeout', '10m'], passwordFile)
      log(`CLI-20 stdin file exit=${created.code} stdout="${hide(created.stdout)}" stderr="${hide(created.stderr)}"`)
      const vms = await get('tenant', '/v1/tenant/vms') as Array<{ id: string, name: string }>
      const vm = vms.find((v) => v.name === VM4_NAME)
      if (vm !== undefined) {
        consoleVmId = vm.id
        cli23UserData = (await getVm(vm.id)).userData ?? null
      }
      expect(created.code, hide(created.stderr)).toBe(0)
      expect(vm, `${VM4_NAME} in GET /v1/tenant/vms`).toBeTruthy()
      expect(created.stdout.includes(password), 'stdout holds the password').toBe(false)
      expect(created.stderr.includes(password), 'stderr holds the password').toBe(false)

      const empty = await runWithStdinFrom([...createArgs(VM5_NAME), '--console-password-stdin'], '/dev/null')
      log(`CLI-20 empty stdin exit=${empty.code} stderr="${hide(empty.stderr)}"`)
      expect(empty.code).not.toBe(0)
      expect(empty.stderr).toContain('no console password on stdin')

      const onTheLine = await runCli([...createArgs(VM5_NAME), '--console-password', password])
      log(`CLI-20 on the command line exit=${onTheLine.code} stderr="${hide(onTheLine.stderr).split('\n')[0]}"`)
      expect(onTheLine.code).not.toBe(0)
      expect(onTheLine.stderr).toContain('unknown flag: --console-password')

      const after = await get('tenant', '/v1/tenant/vms') as Array<{ id: string, name: string }>
      expect(after.filter((v) => v.name === VM5_NAME).map((v) => v.id)).toEqual([])
    } finally {
      fs.rmSync(CONSOLE_PASSWORD_DIR, { recursive: true, force: true })
      if (consoleVmId !== '') {
        // A failure here is logged, not thrown over the case's own error; afterAll tries again and fails the run.
        try {
          const vmId = consoleVmId
          await cleanUp([[`delete VM ${vmId}`, () => deleteOnceSettled(`CLI-20 ${VM4_NAME}`, vmId)]])
          consoleVmId = ''
        } catch (error) {
          log(`CLI-20 delete ${VM4_NAME} failed, afterAll tries again: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  })

  // titan-ops features/vm/user-stories.md#us-vm-userdata AC-4 · titan-ops features/vm/design.md#vm-create-flow ·
  // OpenViCloud/titan-cli:command/vm/lifecycle.go (readUserData: the file's exact bytes, refused before any request when
  // unreadable, past maxUserDataBytes or not UTF-8). The accepted file rode CLI-20's first create.
  test('CLI-23 `vm create --user-data` sends the file byte for byte; a missing, too large or non-UTF-8 file is refused with no VM', async () => {
    try {
      expect(cli23UserData, 'CLI-20 made its VM and read it back').not.toBeNull()
      log(`CLI-23 userData of ${VM4_NAME}: ${JSON.stringify(cli23UserData)}`)
      expect(Buffer.from(cli23UserData!, 'utf8').equals(Buffer.from(CLI23_USER_DATA, 'utf8'))).toBe(true)

      const { clusterId, templateId } = await envOf()
      const network = await runNetwork()
      fs.writeFileSync(`${USER_DATA_DIR}/too-large`, 'a'.repeat(32_769))
      fs.writeFileSync(`${USER_DATA_DIR}/not-utf8`, Buffer.from([0x23, 0x20, 0xff, 0x0a]))
      const refusals: Array<[string, string]> = [
        [`${USER_DATA_DIR}/missing`, 'cannot read the user data file'],
        [`${USER_DATA_DIR}/too-large`, 'is 32769 bytes, more than the 32768 byte limit'],
        [`${USER_DATA_DIR}/not-utf8`, 'is not valid UTF-8'],
      ]
      for (const [file, message] of refusals) {
        const result = await runCli(['vm', 'create', VM6_NAME, '--cluster', clusterId, '--network', network.name,
          '--template', templateId, '--size', 'm', '--user-data', file])
        log(`CLI-23 ${file} exit=${result.code} stderr="${result.stderr.trim()}"`)
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain(message)
      }
      const vms = await get('tenant', '/v1/tenant/vms') as Array<{ id: string, name: string }>
      expect(vms.filter((v) => v.name === VM6_NAME).map((v) => v.id)).toEqual([])
      expect(countOf(await activityOf(VM6_NAME), 'vm.create_requested')).toBe(0)
    } finally {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true })
    }
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
