import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import { closeSessions, useBrowser } from './auth'
import { RESULTS, bodyOf, call, expectStatus, get, log, newKey, sleep, startLog } from './api'
import { RUN, activityOf, countOf } from './fixtures'
import { cleanUp } from './clean-up'
import { newSecret } from './token'
import { CLI_HOME, CliSshChain, setCliToken, waitForBinary } from './cli-ssh'

// Cases CLI-06..11 of plan.md on the release environment: a job of its own (run-module.sh … cli/edge …), since the cli
// module runs on dev only and `vm ssh` there never crosses the edge in front of the release environment's API
// (titan-ops architecture/testing.md#regression-dev-before-candidate). The bodies are lib/cli-ssh.ts, which
// cli/cli.spec.ts runs on dev. The CLI signs in with an API token of beta-user (`rg-tok-edge-*`, OPENVICLOUD_TOKEN), not
// `auth login`, so this job needs no browser login and `vm ssh` with a token is measured too. It counts beta-user's SSH
// sessions (CLI-11), so no other job that opens one (cli, vm/ssh-sessions) runs beside it.
//
// CLI-10 runs on the agent's machine, the customer's path through the edge, at a hold
// (titan-ops .claude/shared/regression-suite.md §Runner): the spec writes the token and the key to /work/cli-10 (never
// under RESULTS, which becomes evidence), logs `HOLD cli10 {…}` and waits for /work/results/go-cli10 (the agent ran
// it) or /work/results/skip-cli10 (N/A). The agent's own log holds the verdict; the spec checks that the session
// reached this VM, then deletes the token whatever happened.
const chain = new CliSshChain('/work/ssh-cli-edge', `rg-vmedge-${RUN}`, `rg-ssh-edge-${RUN}`)
const HAND_OFF = '/work/cli-10'
const HOLD_MS = 45 * 60_000
let tokenId = ''
let secret = ''

// Waits for the agent's answer to a hold: true on go-<step>, false on skip-<step>; no answer within HOLD_MS fails.
async function hold(step: string, facts: Record<string, unknown>): Promise<boolean> {
  log(`HOLD ${step} ${JSON.stringify(facts)}`)
  const deadline = Date.now() + HOLD_MS
  while (Date.now() < deadline) {
    if (fs.existsSync(`${RESULTS}/go-${step}`)) {
      log(`GO ${step}`)
      return true
    }
    if (fs.existsSync(`${RESULTS}/skip-${step}`)) {
      log(`SKIP ${step}`)
      return false
    }
    await sleep(5_000)
  }
  throw new Error(`HOLD ${step}: no go after ${HOLD_MS / 60_000} minutes`)
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(10 * 60_000)
  startLog('cli-edge')
  useBrowser(browser)
  fs.mkdirSync(CLI_HOME, { recursive: true })
  // The CLI refuses every command until the current terms are accepted (OpenViCloud/titan-cli:command/root.go Deps.Client,
  // Deps.mustAcceptTerms).
  const consent = await get('tenant', '/v1/legal/consent-status')
  if (consent.mustAcceptTerms) {
    expectStatus(await call('tenant', 'POST', '/v1/legal/acceptance'), 204)
    log('setup: beta-user accepted the current terms')
  }
  // The secret is made here (lib/token.ts) and never logged; 30 days is the shortest lifetime the API takes, and
  // afterAll deletes the token.
  secret = newSecret()
  const created = await call('tenant', 'POST', '/v1/tenant/api-tokens',
    { name: `rg-tok-edge-${RUN}`, token: secret, expiresInDays: 30 }, newKey())
  expectStatus(created, 201)
  tokenId = bodyOf(created).apiTokenId
  setCliToken(secret)
  log(`setup: API token ${tokenId} for the CLI`)
  await waitForBinary()
})

test.afterAll(async () => {
  test.setTimeout(15 * 60_000)
  const steps: Array<[string, () => Promise<void>]> = [
    ['hand-off files', async () => {
      fs.rmSync(HAND_OFF, { recursive: true, force: true })
    }],
    ['chain', () => chain.cleanUp()],
  ]
  if (tokenId !== '') {
    steps.push([`delete API token ${tokenId}`, async () => {
      const deleted = await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${tokenId}`)
      expect([204, 404], `${deleted.url} → ${deleted.text.slice(0, 200)}`).toContain(deleted.status)
    }])
  }
  steps.push(['sessions', closeSessions])
  await cleanUp(steps)
})

test.describe.serial('cli edge', () => {
  test.describe.configure({ timeout: 25 * 60_000 })

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

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ShellRelay.cs ShellRelayOptions.Default (IdleTimeout):
  // only 30 minutes without a byte either way ends a session; the edge in front of the API must not end it sooner.
  test('CLI-10 a session with no byte for 5 minutes stays open, from the agent\'s machine through the edge', async () => {
    test.setTimeout(HOLD_MS + 20 * 60_000)
    await chain.startAgainAndReach()
    fs.rmSync(HAND_OFF, { recursive: true, force: true })
    fs.mkdirSync(HAND_OFF, { mode: 0o700 })
    fs.writeFileSync(`${HAND_OFF}/token`, secret, { mode: 0o600 })
    fs.copyFileSync(`${chain.sshDir}/rg-key`, `${HAND_OFF}/key`)
    fs.chmodSync(`${HAND_OFF}/key`, 0o600)
    const before = countOf(await activityOf(chain.vmName), 'vm.ssh_requested')
    const go = await hold('cli10', { vmName: chain.vmName, vmId: chain.vmId, token: `${HAND_OFF}/token`, key: `${HAND_OFF}/key`,
      command: "vm ssh <vmName> -- -i <key> -o IdentitiesOnly=yes -o BatchMode=yes 'sleep 330; echo alive'" })
    fs.rmSync(HAND_OFF, { recursive: true, force: true })
    test.skip(!go, 'CLI-10: the agent answered skip-cli10')
    const after = countOf(await activityOf(chain.vmName), 'vm.ssh_requested')
    log(`CLI-10 vm.ssh_requested before the hold=${before} after=${after}`)
    expect(after, 'the agent\'s session reached this VM').toBeGreaterThan(before)
  })
})
