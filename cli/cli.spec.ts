import { test, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { PORTAL, closeSessions, useBrowser } from './auth'
import { startLocalProxyIfNeeded } from './local-proxy'
import { API, RESULTS, bodyOf, call, expectError, expectStatus, get, log, newKey, sleep, startLog } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, getVm, runNetwork, runs, vmShape, waitVm } from './fixtures'
import { cleanUp } from './clean-up'
import { newSecret } from './token'

// Cases CLI-01..18 of plan.md, in five describes that run in this order: 'cli' (CLI-01..03, CLI-06..11),
// 'cli catalog' (CLI-05), 'cli lifecycle' (CLI-12..17), 'cli api token' (CLI-18), 'cli logout' (CLI-04). The binary is not in the image: when
// this spec logs BINARY_WAIT the agent copies `openvicloud` built for the pod's architecture from the CLI commit the
// release measures to /work/bin/openvicloud, checks sha256, then touches /work/bin/openvicloud.ready
// (release:regression §Runner).
// Tokens stay in this process.
//
// Login and the binary wait are file-level (outside every describe): Playwright restarts the worker process after
// any failed test in this file (workers: 1, fullyParallel: false — OpenViCloud/titan-local-cluster:base/regression-runner/runner-configmap.yaml),
// which drops module state (authUrl, browserRef) and re-runs only the hooks of describes that still have tests
// left — a root-level beforeAll runs again, a nested one does not. The CLI's own session lives on disk under
// CLI_HOME and survives a worker restart, so login happens at most once. A red case in CLI-06..11's serial chain
// skips the rest of the chain, so CLI-05, CLI-12..18 and CLI-04 sit in their own describes. CLI-10, the long idle
// session the edge sometimes cuts, is last of the chain. CLI-04 is last of all five because it logs the CLI out.
const BINARY = '/work/bin/openvicloud'
const CLI_HOME = '/work/cli-home'

type CliResult = { code: number, stdout: string, stderr: string }

let authUrl = ''

function cliEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: '/work',
    XDG_CONFIG_HOME: CLI_HOME,
    OPENVICLOUD_API_URL: API,
    OPENVICLOUD_AUTH_URL: authUrl,
    OPENVICLOUD_PORTAL_URL: PORTAL,
  }
}

function runCli(args: string[]): Promise<CliResult> {
  return run(BINARY, args)
}

// Any program with the CLI's environment: ssh and scp run the CLI as their ProxyCommand.
function run(program: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: cliEnv() })
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

// Like run(), but writes `input` to stdin and closes it — for `vm delete`'s confirmation prompt
// (OpenViCloud/titan-cli:command/root.go Deps.Confirm reads one line from Stdin; without a close that read never returns).
function runWithStdin(args: string[], input: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(BINARY, args, { env: cliEnv() })
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
    child.stdin.write(input)
    child.stdin.end()
  })
}

async function waitForBinary(): Promise<void> {
  if (fs.existsSync(`${BINARY}.ready`)) {
    fs.chmodSync(BINARY, 0o755)
    return
  }
  log('BINARY_WAIT copy the binary to /work/bin/openvicloud, then touch /work/bin/openvicloud.ready')
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    if (fs.existsSync(`${BINARY}.ready`)) {
      fs.chmodSync(BINARY, 0o755)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error(`the agent never copied ${BINARY}`)
}

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

const SSH_DIR = '/work/ssh-cli'
const VM_NAME = `rg-vmcli-${RUN}`
let vmId = ''
let keyId = ''
let attempts = 0

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function sshOptions(dir: string, key: string, hostKeyCheck: 'accept-new' | 'yes'): string[] {
  return ['-i', `${dir}/${key}`, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${hostKeyCheck}`, '-o', `UserKnownHostsFile=${dir}/known_hosts`,
    '-o', 'ConnectTimeout=30', '-o', 'LogLevel=ERROR']
}

// `openvicloud vm ssh <name> -- <options> <command>`: every call that reaches the running VM is one attempt.
async function vmSsh(key: string, hostKeyCheck: 'accept-new' | 'yes', command: string[]): Promise<CliResult> {
  attempts++
  return runCli(['vm', 'ssh', VM_NAME, '--', ...sshOptions(SSH_DIR, key, hostKeyCheck), ...command])
}

// Right after the VM runs, the guest is still starting: VM_AGENT_NOT_READY, ssh exiting 255 with nothing to say at
// LogLevel=ERROR, or a refused key. Retries `id -un` for up to 5 minutes and returns the last result.
async function sshOnceUp(label: string, hostKeyCheck: 'accept-new' | 'yes'): Promise<CliResult> {
  const deadline = Date.now() + 5 * 60_000
  let result = await vmSsh('rg-key', hostKeyCheck, ['id', '-un'])
  while (result.code !== 0 && Date.now() < deadline) {
    const sshdNotUp = result.code === 255 && result.stderr.trim() === ''
    const waiting = sshdNotUp || /VM_AGENT_NOT_READY|Permission denied|Connection closed/.test(result.stderr)
    expect(waiting, `exit=${result.code} stderr=${result.stderr}`).toBe(true)
    log(`${label} not yet: exit=${result.code} ${result.stderr.trim().slice(0, 160)}`)
    await sleep(10_000)
    result = await vmSsh('rg-key', hostKeyCheck, ['id', '-un'])
  }
  return result
}

// scp has no `vm ssh`: it gets the same ProxyCommand and host key alias the CLI gives ssh.
async function scp(from: string, to: string): Promise<CliResult> {
  attempts++
  return run('scp', [...sshOptions(SSH_DIR, 'rg-key', 'yes'), '-o', `ProxyCommand='${BINARY}' vm tunnel ${vmId}`,
    '-o', `HostKeyAlias=openvicloud-${vmId}`, from, to])
}

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
  authUrl = `${config.keycloakUrl}/realms/${config.keycloakRealm}`
  log(`cli auth url ${authUrl}`)
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
    expect(info.auth).toBe(authUrl)
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
  // Key pairs are made in the pod for this run and never leave it. Every attempt that reaches a running VM is one
  // vm.ssh_requested row (OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/RequestVmSshCommandHandler.cs HandleAsync records it
  // before the exec opens).

  // OpenViCloud/titan-cli:command/vm/vm.go SshArgs (ssh's arguments) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs (OpenVmSshEndpoint) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusExecSession.cs IncusShellConnector.SshCommand (nc -N to port 22)
  test('CLI-06 `vm ssh` reaches a running VM with the tenant\'s key; known_hosts keeps it under openvicloud-<id>', async () => {
    const { smallTier } = await envOf()
    fs.rmSync(SSH_DIR, { recursive: true, force: true })
    fs.mkdirSync(SSH_DIR, { recursive: true })
    for (const pair of ['rg-key', 'rg-stranger']) {
      const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${pair}-${RUN}`, '-f', `${SSH_DIR}/${pair}`])
      expect(made.code, made.stderr).toBe(0)
    }
    const added = await call('tenant', 'POST', '/v1/tenant/ssh-keys',
      { name: `rg-ssh-cli-${RUN}`, publicKey: fs.readFileSync(`${SSH_DIR}/rg-key.pub`, 'utf8').trim() }, newKey())
    expectStatus(added, 201)
    keyId = bodyOf(added).id
    vmId = await createVm(VM_NAME, smallTier, (await runNetwork()).id, { sshKeyIds: [keyId] })
    await waitVm(`CLI-06 ${VM_NAME}`, vmId, (v) => runs(v))

    const result = await sshOnceUp('CLI-06', 'accept-new')
    log(`CLI-06 exit=${result.code} stdout="${result.stdout.trim()}"`)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('ubuntu')
    // ssh_config may hash the names in known_hosts (Ubuntu does): ask ssh-keygen, which finds hashed entries too.
    const known = await run('ssh-keygen', ['-F', `openvicloud-${vmId}`, '-f', `${SSH_DIR}/known_hosts`])
    log(`CLI-06 ssh-keygen -F exit=${known.code}`)
    expect(known.code, known.stderr).toBe(0)
    expect(known.stdout).toContain(`Host openvicloud-${vmId} found`)
  })

  // scp over the same tunnel: 1 MiB each way, sha256 equal where it was written and where it landed
  test('CLI-07 scp through the tunnel carries 1 MiB each way unchanged', async () => {
    const up = crypto.randomBytes(1 << 20)
    fs.writeFileSync(`${SSH_DIR}/up.bin`, up)
    const sent = await scp(`${SSH_DIR}/up.bin`, `ubuntu@${VM_NAME}:/tmp/rg-up.bin`)
    expect(sent.code, sent.stderr).toBe(0)
    const inGuest = await vmSsh('rg-key', 'yes', ['sha256sum', '/tmp/rg-up.bin'])
    expect(inGuest.code, inGuest.stderr).toBe(0)
    expect(inGuest.stdout.split(' ')[0]).toBe(sha256(up))

    const made = await vmSsh('rg-key', 'yes', ['head -c 1048576 /dev/urandom > /tmp/rg-down.bin && sha256sum /tmp/rg-down.bin'])
    expect(made.code, made.stderr).toBe(0)
    const fetched = await scp(`ubuntu@${VM_NAME}:/tmp/rg-down.bin`, `${SSH_DIR}/down.bin`)
    expect(fetched.code, fetched.stderr).toBe(0)
    const down = fs.readFileSync(`${SSH_DIR}/down.bin`)
    expect(down.length).toBe(1 << 20)
    expect(sha256(down)).toBe(made.stdout.split(' ')[0])
    log(`CLI-07 up ${sha256(up)} · down ${sha256(down)}`)
  })

  // Closing ssh ends the guest's side: nc -N passes the end to sshd
  // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusExecSession.cs IncusShellConnector.SshCommand), so a failed login leaves
  // no nc and no sshd behind. ssh's own failure is exit 255.
  test('CLI-08 a key the VM does not hold is refused with exit 255 and leaves no process in the guest', async () => {
    const stranger = await vmSsh('rg-stranger', 'yes', ['id', '-un'])
    log(`CLI-08 stranger exit=${stranger.code} stderr="${stranger.stderr.trim()}"`)
    expect(stranger.code).toBe(255)
    expect(stranger.stderr).toMatch(/Permission denied/)

    await sleep(3_000)
    const ps = await vmSsh('rg-key', 'yes', ['ps', '-eo', 'args'])
    expect(ps.code, ps.stderr).toBe(0)
    const lines = ps.stdout.split('\n').map((line) => line.trim())
    const sessionLines = lines.filter((line) => line.startsWith('nc ') || line.startsWith('sshd: '))
    log(`CLI-08 guest processes while one session is open: ${JSON.stringify(sessionLines)}`)
    // The session that runs ps holds exactly one nc and one privileged sshd; the refused one left none.
    expect(lines.filter((line) => line === 'nc -N 127.0.0.1 22').length).toBe(1)
    expect(lines.filter((line) => line.startsWith('sshd: ubuntu [priv]')).length).toBe(1)
    expect(lines.filter((line) => line.includes('[preauth]')).length).toBe(0)
  })

  // OpenViCloud/titan-cli:command/root.go ExitCodeOf, OpenViCloud/titan-cli:cmd/openvicloud/main.go main: the CLI exits with ssh's exit code,
  // which is the remote command's
  test('CLI-09 the remote command\'s exit code is the CLI\'s exit code', async () => {
    const result = await vmSsh('rg-key', 'yes', ['exit', '7'])
    log(`CLI-09 exit=${result.code}`)
    expect(result.code).toBe(7)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs HandleAsync (WEBSOCKET_REQUIRED) ·
  // OpenViCloud/titan-cli:command/vm/vm.go resolve (unknown name) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Compute/Vm/Vm.cs ShellInstanceName (not running) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/RequestVmSshCommandHandler.cs HandleAsync (one activity row per attempt on a running VM, none on a VM that is not running)
  test('CLI-11 refusals: a plain GET, an unknown VM, a stopped VM; activity counts the attempts', async () => {
    expectError(await call('tenant', 'GET', `/v1/tenant/vms/${vmId}/ssh`), 400, 'WEBSOCKET_REQUIRED')
    const unknown = await runCli(['vm', 'ssh', `rg-nope-${RUN}`])
    log(`CLI-11 unknown exit=${unknown.code} stderr="${unknown.stderr.trim()}"`)
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toMatch(/no VM named/)

    const before = countOf(await activityOf(VM_NAME), 'vm.ssh_requested')
    log(`CLI-11 vm.ssh_requested rows=${before} attempts=${attempts}`)
    expect(before).toBe(attempts)

    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/stop`), 202)
    await waitVm(`CLI-11 ${VM_NAME} stopped`, vmId, (v) => v.currentState === 'Stopped')
    const stopped = await vmSsh('rg-key', 'yes', ['id', '-un'])
    log(`CLI-11 stopped exit=${stopped.code} stderr="${stopped.stderr.trim()}"`)
    expect(stopped.code).not.toBe(0)
    expect(stopped.stderr).toContain('(VM_INVALID_STATUS)')
    expect(countOf(await activityOf(VM_NAME), 'vm.ssh_requested')).toBe(before)
  })

  // Last of the chain: if the edge cuts this long session, no later case goes unmeasured. CLI-11 left the VM stopped.
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ShellRelay.cs ShellRelayOptions.Default (IdleTimeout): only 30 minutes without a byte either way ends a session
  test('CLI-10 a session with no byte for 5 minutes stays open', async () => {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/start`), 202)
    await waitVm(`CLI-10 ${VM_NAME} running again`, vmId, (v) => runs(v))
    const up = await sshOnceUp('CLI-10', 'yes')
    expect(up.code, up.stderr).toBe(0)
    const started = Date.now()
    const result = await vmSsh('rg-key', 'yes', ['sleep 330; echo alive'])
    const seconds = Math.round((Date.now() - started) / 1000)
    log(`CLI-10 exit=${result.code} stdout="${result.stdout.trim()}" after ${seconds} s`)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('alive')
    expect(seconds).toBeGreaterThanOrEqual(330)
  })

  test.afterAll(async () => {
    const steps: Array<[string, () => Promise<void>]> = []
    if (vmId !== '') {
      steps.push([`delete VM ${vmId}`, () => deleteVmAndWait(vmId)])
    }
    if (keyId !== '') {
      steps.push([`delete SSH key ${keyId}`, async () => {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${keyId}`), 204)
      }])
    }
    await cleanUp(steps)
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
    // price and cpu fields are compared as raw text, not parsed.
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
      expect(rawNumberField(sizeResult.stdout, offering.id, 'cpu'))
        .toBe(rawNumberField(offeringsReply.text, offering.id, 'cpu'))
    }
    log(`CLI-05 clusters=${clustersFromApi.length} templates=${templatesFromApi.length} sizes=${offeringsFromApi.length}`)
  })
})

// --- CLI-12..17: ssh-key + VM lifecycle commands, on the run's network ------------------------------------------
// A separate key pair and ssh directory from CLI-06..11's: registering the same public key twice is 409
// SSH_KEY_EXISTS, and vmSsh()/scp() above count attempts that CLI-11 already checked against the activity feed.
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
    test.setTimeout(20 * 60_000)
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
    expect(created.stdout).toMatch(/State:\s+(Running|Ready)\s*$/m)

    const idMatch = created.stdout.match(/^ID:\s+(\S+)/m)
    expect(idMatch, created.stdout).not.toBeNull()
    lifecycleVmId = idMatch![1]
    const fromApi = await getVm(lifecycleVmId)
    log(`CLI-13 api ${vmShape(fromApi)}`)
    expect(fromApi.transition).toBeNull()
    expect(['Running', 'Ready']).toContain(fromApi.currentState)

    const deadline = Date.now() + 5 * 60_000
    let result = await runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key', 'accept-new'), 'id', '-un'])
    while (result.code !== 0 && Date.now() < deadline) {
      const sshdNotUp = result.code === 255 && result.stderr.trim() === ''
      const waiting = sshdNotUp || /VM_AGENT_NOT_READY|Permission denied|Connection closed/.test(result.stderr)
      expect(waiting, `exit=${result.code} stderr=${result.stderr}`).toBe(true)
      log(`CLI-13 ssh not yet: exit=${result.code} ${result.stderr.trim().slice(0, 160)}`)
      await sleep(10_000)
      result = await runCli(['vm', 'ssh', VM2_NAME, '--', ...sshOptions(LIFECYCLE_SSH_DIR, 'key', 'accept-new'), 'id', '-un'])
    }
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
    expect(stopped.stdout).toMatch(/State:\s+Stopped\s*$/m)

    const started = await runCli(['vm', 'start', VM2_NAME, '--wait'])
    log(`CLI-14 start exit=${started.code} stdout="${started.stdout.trim()}"`)
    expect(started.code, started.stderr).toBe(0)
    expect(started.stdout).toMatch(/State:\s+(Running|Ready)\s*$/m)
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
  test('CLI-15 rename, decline delete, then `--yes --wait` deletes and the API shows currentExistence Deleted', async () => {
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
    expect(stillThere.currentExistence).not.toBe('Deleted')

    const deletedResult = await runCli(['vm', 'delete', VM3_NAME, '--yes', '--wait'])
    log(`CLI-15 delete exit=${deletedResult.code} stderr="${deletedResult.stderr.trim()}"`)
    expect(deletedResult.code, deletedResult.stderr).toBe(0)
    // The delete branch of newRequest only calls deps.Printer.Message("VM %s deleted.", …), to Err.
    expect(deletedResult.stderr).toMatch(/deleted/)
    const fromApi = await getVm(lifecycleVmId)
    log(`CLI-15 api ${vmShape(fromApi)}`)
    expect(fromApi.currentExistence).toBe('Deleted')
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
