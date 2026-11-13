import { expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { PORTAL } from './auth'
import { API, bodyOf, call, expectError, expectStatus, log, newKey, sleep } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, runNetwork, runs, waitVm } from './fixtures'
import { cleanUp } from './clean-up'
import { GUEST_START_WAIT_MS } from './ssh'

// The CLI as a spec runs it, and the chain CLI-06..11 of plan.md, shared by cli/cli.spec.ts (dev) and
// cli/edge/cli-edge.spec.ts (prd: titan-ops architecture/testing.md#regression-dev-before-candidate). The binary is
// not in the image: when a spec logs BINARY_WAIT the agent copies `openvicloud` built for the pod's architecture to
// /work/bin/openvicloud, checks sha256, then touches /work/bin/openvicloud.ready
// (titan-ops .claude/shared/regression-suite.md §Runner).
export const BINARY = '/work/bin/openvicloud'
export const CLI_HOME = '/work/cli-home'

export type CliResult = { code: number, stdout: string, stderr: string }

// The issuer of `auth login`, and an API token: with one set the CLI never reads a login session
// (OpenViCloud/titan-cli:command/root.go Deps.AccessToken).
const settings = { authUrl: '', token: '' }

export function setCliAuthUrl(url: string): void {
  settings.authUrl = url
}

export function cliAuthUrl(): string {
  return settings.authUrl
}

export function setCliToken(secret: string): void {
  settings.token = secret
}

export function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: '/work',
    XDG_CONFIG_HOME: CLI_HOME,
    OPENVICLOUD_API_URL: API,
    OPENVICLOUD_AUTH_URL: settings.authUrl,
    OPENVICLOUD_PORTAL_URL: PORTAL,
  }
  if (settings.token !== '') {
    env.OPENVICLOUD_TOKEN = settings.token
  }
  return env
}

export function runCli(args: string[]): Promise<CliResult> {
  return run(BINARY, args)
}

// Any program with the CLI's environment: ssh and scp run the CLI as their ProxyCommand.
export function run(program: string, args: string[]): Promise<CliResult> {
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
export function runWithStdin(args: string[], input: string): Promise<CliResult> {
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

export async function waitForBinary(): Promise<void> {
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

export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export function sshOptions(dir: string, key: string, hostKeyCheck: 'accept-new' | 'yes'): string[] {
  return ['-i', `${dir}/${key}`, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${hostKeyCheck}`, '-o', `UserKnownHostsFile=${dir}/known_hosts`,
    '-o', 'ConnectTimeout=30', '-o', 'LogLevel=ERROR']
}

// A call the control plane refuses before the session opens prints `<title> (<CODE>)` and records no activity
// (titan-ops features/vm/design.md#ssh-session); every other call opened a session and is one vm.ssh_requested row.
export const SESSION_REFUSED = /\((VM_[A-Z_]+|CLUSTER_[A-Z_]+|TENANT_[A-Z_]+|WEBSOCKET_REQUIRED)\)/

// Right after the VM runs, the guest is still starting: VM_AGENT_NOT_READY (agent not up), VM_SSH_NOT_READY (agent up,
// sshd not listening yet), ssh exiting 255 with nothing to say at LogLevel=ERROR (a control plane older than
// VM_SSH_NOT_READY), or a refused key.
export function guestStillStarting(result: CliResult): boolean {
  const sshdNotUp = result.code === 255 && result.stderr.trim() === ''
  return sshdNotUp || /VM_AGENT_NOT_READY|VM_SSH_NOT_READY|Permission denied|Connection closed/.test(result.stderr)
}

// Retries `attempt` while the guest is still starting, for up to GUEST_START_WAIT_MS; any other failure fails at once.
export async function untilGuestAnswers(label: string, attempt: () => Promise<CliResult>): Promise<CliResult> {
  const deadline = Date.now() + GUEST_START_WAIT_MS
  let result = await attempt()
  while (result.code !== 0 && Date.now() < deadline) {
    expect(guestStillStarting(result), `exit=${result.code} stderr=${result.stderr}`).toBe(true)
    log(`${label} not yet: exit=${result.code} ${result.stderr.trim().slice(0, 160)}`)
    await sleep(10_000)
    result = await attempt()
  }
  return result
}

// One VM with one tenant key, reached by `vm ssh`, and the cases CLI-06..09 and CLI-11 run on it in that order.
// `attempts` counts the calls that opened a session, which CLI-11 checks against the activity feed.
export class CliSshChain {
  readonly sshDir: string
  readonly vmName: string
  readonly keyName: string
  vmId = ''
  keyId = ''
  attempts = 0

  constructor(sshDir: string, vmName: string, keyName: string) {
    this.sshDir = sshDir
    this.vmName = vmName
    this.keyName = keyName
  }

  countOpened(result: CliResult): CliResult {
    if (!SESSION_REFUSED.test(result.stderr)) {
      this.attempts++
    }
    return result
  }

  // `openvicloud vm ssh <name> -- <options> <command>`: every call that opens a session on the running VM is one attempt.
  async vmSsh(key: string, hostKeyCheck: 'accept-new' | 'yes', command: string[]): Promise<CliResult> {
    return this.countOpened(await runCli(['vm', 'ssh', this.vmName, '--', ...sshOptions(this.sshDir, key, hostKeyCheck), ...command]))
  }

  // scp has no `vm ssh`: it gets the same ProxyCommand and host key alias the CLI gives ssh.
  async scp(from: string, to: string): Promise<CliResult> {
    return this.countOpened(await run('scp', [...sshOptions(this.sshDir, 'rg-key', 'yes'),
      '-o', `ProxyCommand='${BINARY}' vm tunnel ${this.vmId}`, '-o', `HostKeyAlias=openvicloud-${this.vmId}`, from, to]))
  }

  sshOnceUp(label: string, hostKeyCheck: 'accept-new' | 'yes'): Promise<CliResult> {
    return untilGuestAnswers(label, () => this.vmSsh('rg-key', hostKeyCheck, ['id', '-un']))
  }

  // CLI-06 · OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusExecSession.cs IncusShellConnector.SshCommand
  // (nc -N to port 22)
  async cli06(): Promise<void> {
    const { smallTier } = await envOf()
    fs.rmSync(this.sshDir, { recursive: true, force: true })
    fs.mkdirSync(this.sshDir, { recursive: true })
    for (const pair of ['rg-key', 'rg-stranger']) {
      const made = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${pair}-${RUN}`, '-f', `${this.sshDir}/${pair}`])
      expect(made.code, made.stderr).toBe(0)
    }
    const added = await call('tenant', 'POST', '/v1/tenant/ssh-keys',
      { name: this.keyName, publicKey: fs.readFileSync(`${this.sshDir}/rg-key.pub`, 'utf8').trim() }, newKey())
    expectStatus(added, 201)
    this.keyId = bodyOf(added).id
    this.vmId = await createVm(this.vmName, smallTier, (await runNetwork()).id, { sshKeyIds: [this.keyId] })
    await waitVm(`CLI-06 ${this.vmName}`, this.vmId, (v) => runs(v))

    const result = await this.sshOnceUp('CLI-06', 'accept-new')
    log(`CLI-06 exit=${result.code} stdout="${result.stdout.trim()}"`)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('ubuntu')
    // ssh_config may hash the names in known_hosts (Ubuntu does): ask ssh-keygen, which finds hashed entries too.
    const known = await run('ssh-keygen', ['-F', `openvicloud-${this.vmId}`, '-f', `${this.sshDir}/known_hosts`])
    log(`CLI-06 ssh-keygen -F exit=${known.code}`)
    expect(known.code, known.stderr).toBe(0)
    expect(known.stdout).toContain(`Host openvicloud-${this.vmId} found`)
  }

  // CLI-07 · scp over the same tunnel: 1 MiB each way, sha256 equal where it was written and where it landed
  async cli07(): Promise<void> {
    const up = crypto.randomBytes(1 << 20)
    fs.writeFileSync(`${this.sshDir}/up.bin`, up)
    const sent = await this.scp(`${this.sshDir}/up.bin`, `ubuntu@${this.vmName}:/tmp/rg-up.bin`)
    expect(sent.code, sent.stderr).toBe(0)
    const inGuest = await this.vmSsh('rg-key', 'yes', ['sha256sum', '/tmp/rg-up.bin'])
    expect(inGuest.code, inGuest.stderr).toBe(0)
    expect(inGuest.stdout.split(' ')[0]).toBe(sha256(up))

    const made = await this.vmSsh('rg-key', 'yes', ['head -c 1048576 /dev/urandom > /tmp/rg-down.bin && sha256sum /tmp/rg-down.bin'])
    expect(made.code, made.stderr).toBe(0)
    const fetched = await this.scp(`ubuntu@${this.vmName}:/tmp/rg-down.bin`, `${this.sshDir}/down.bin`)
    expect(fetched.code, fetched.stderr).toBe(0)
    const down = fs.readFileSync(`${this.sshDir}/down.bin`)
    expect(down.length).toBe(1 << 20)
    expect(sha256(down)).toBe(made.stdout.split(' ')[0])
    log(`CLI-07 up ${sha256(up)} · down ${sha256(down)}`)
  }

  // CLI-08 · Closing ssh ends the guest's side: nc -N passes the end to sshd
  // (OpenViCloud/titan-control-plane:Titan.Infrastructure/Incus/IncusExecSession.cs IncusShellConnector.SshCommand), so a
  // failed login leaves no nc and no sshd behind. ssh's own failure is exit 255.
  async cli08(): Promise<void> {
    const stranger = await this.vmSsh('rg-stranger', 'yes', ['id', '-un'])
    log(`CLI-08 stranger exit=${stranger.code} stderr="${stranger.stderr.trim()}"`)
    expect(stranger.code).toBe(255)
    expect(stranger.stderr).toMatch(/Permission denied/)

    await sleep(3_000)
    const ps = await this.vmSsh('rg-key', 'yes', ['ps', '-eo', 'args'])
    expect(ps.code, ps.stderr).toBe(0)
    const lines = ps.stdout.split('\n').map((line) => line.trim())
    const sessionLines = lines.filter((line) => line.startsWith('nc ') || line.startsWith('sshd: '))
    log(`CLI-08 guest processes while one session is open: ${JSON.stringify(sessionLines)}`)
    // The session that runs ps holds exactly one nc and one privileged sshd; the refused one left none.
    expect(lines.filter((line) => line === 'nc -N 127.0.0.1 22').length).toBe(1)
    expect(lines.filter((line) => line.startsWith('sshd: ubuntu [priv]')).length).toBe(1)
    expect(lines.filter((line) => line.includes('[preauth]')).length).toBe(0)
  }

  // CLI-09 · OpenViCloud/titan-cli:command/root.go ExitCodeOf, OpenViCloud/titan-cli:cmd/openvicloud/main.go main: the
  // CLI exits with ssh's exit code, which is the remote command's
  async cli09(): Promise<void> {
    const result = await this.vmSsh('rg-key', 'yes', ['exit', '7'])
    log(`CLI-09 exit=${result.code}`)
    expect(result.code).toBe(7)
  }

  // CLI-11 · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs HandleAsync
  // (WEBSOCKET_REQUIRED) · OpenViCloud/titan-cli:command/vm/vm.go resolve (unknown name) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.Guards.cs EnsureShellCanOpen (not Running or Ready) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Vm/RequestVmSshCommandHandler.cs HandleAsync (one
  // activity row per session opened on a running VM, none for a refusal). Leaves the VM stopped.
  async cli11(): Promise<void> {
    expectError(await call('tenant', 'GET', `/v1/tenant/vms/${this.vmId}/ssh`), 400, 'WEBSOCKET_REQUIRED')
    const unknown = await runCli(['vm', 'ssh', `rg-nope-${RUN}`])
    log(`CLI-11 unknown exit=${unknown.code} stderr="${unknown.stderr.trim()}"`)
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toMatch(/no VM named/)

    const before = countOf(await activityOf(this.vmName), 'vm.ssh_requested')
    log(`CLI-11 vm.ssh_requested rows=${before} attempts=${this.attempts}`)
    expect(before).toBe(this.attempts)

    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${this.vmId}/stop`), 202)
    await waitVm(`CLI-11 ${this.vmName} stopped`, this.vmId, (v) => v.status === 'Stopped')
    const stopped = await this.vmSsh('rg-key', 'yes', ['id', '-un'])
    log(`CLI-11 stopped exit=${stopped.code} stderr="${stopped.stderr.trim()}"`)
    expect(stopped.code).not.toBe(0)
    expect(stopped.stderr).toContain('(VM_INVALID_STATUS)')
    expect(countOf(await activityOf(this.vmName), 'vm.ssh_requested')).toBe(before)
  }

  // Start of CLI-10: CLI-11 left the VM stopped; start it and wait until `vm ssh` gets in.
  async startAgainAndReach(): Promise<void> {
    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${this.vmId}/start`), 202)
    await waitVm(`CLI-10 ${this.vmName} running again`, this.vmId, (v) => runs(v))
    const up = await this.sshOnceUp('CLI-10', 'yes')
    expect(up.code, up.stderr).toBe(0)
  }

  async cleanUp(): Promise<void> {
    const steps: Array<[string, () => Promise<void>]> = []
    if (this.vmId !== '') {
      const vmId = this.vmId
      steps.push([`delete VM ${vmId}`, () => deleteVmAndWait(vmId)])
    }
    if (this.keyId !== '') {
      const keyId = this.keyId
      steps.push([`delete SSH key ${keyId}`, async () => {
        expectStatus(await call('tenant', 'DELETE', `/v1/tenant/ssh-keys/${keyId}`), 204)
      }])
    }
    await cleanUp(steps)
  }
}
