import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { closeSessions, useBrowser } from './auth'
import { API, RESULTS, bodyOf, call, expectStatus, log, newKey, startLog } from './api'
import { RUN, envOf } from './fixtures'
import { cleanUp } from './clean-up'
import { newSecret } from './token'

// Cases TFP-01..03, 05..07, 09, 10 of plan.md: the acceptance tests of OpenViCloud/terraform-provider-openvicloud, run
// inside the cluster so the API token never leaves the pod. The token is made here with beta-user's JWT, handed to the
// tests by environment only, and deleted in afterAll. The binary is `go test -c` of the provider commit the release
// measures, built for the node's architecture; the agent copies it through the runner's BINARY_WAIT path
// (/work/bin/openvicloud, the name run-module.sh writes). terraform-plugin-testing finds no terraform in PATH and
// installs one with hc-install. Runs after cleanup: the tests create networks and beta-user may hold one. Resources a
// red run leaves are named tfacc-*: a red run is followed at once by one more cleanup job, which sweeps them.
// TFP-04 and TFP-08 are by hand.
const BINARY = '/work/bin/openvicloud'
const secret = newSecret()
let tokenId = ''

test.beforeAll(async ({ browser }) => {
  test.setTimeout(20 * 60_000)
  startLog('terraform-provider')
  useBrowser(browser)
  const created = await call('tenant', 'POST', '/v1/tenant/api-tokens', { name: `rg-tok-tfp-${RUN}`, token: secret, expiresInDays: 30 }, newKey())
  expectStatus(created, 201)
  tokenId = bodyOf(created).apiTokenId
  log(`token rg-tok-tfp-${RUN} id=${tokenId}`)
  console.log('BINARY_WAIT')
  for (let i = 0; i < 180 && !fs.existsSync(`${BINARY}.ready`); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  expect(fs.existsSync(`${BINARY}.ready`), 'the agent copied the acceptance test binary').toBe(true)
})

test.afterAll(async () => {
  test.setTimeout(5 * 60_000)
  const steps: Array<[string, () => Promise<void>]> = []
  if (tokenId !== '') {
    steps.push([`delete token ${tokenId}`, async () => {
      const deleted = await call('tenant', 'DELETE', `/v1/tenant/api-tokens/${tokenId}`)
      log(`afterAll: delete token → ${deleted.status}`)
      expect([204, 404], `${deleted.url} → ${deleted.text.slice(0, 200)}`).toContain(deleted.status)
    }])
  }
  steps.push(['close sessions', closeSessions])
  await cleanUp(steps)
})

test('TFP-01..03, TFP-05..07, TFP-09..10 the provider acceptance tests pass against the env, with a token made in the pod', async () => {
  test.setTimeout(50 * 60_000)
  fs.mkdirSync('/work/tfacc', { recursive: true })
  // The cluster of the env (envOf: the first one with a listed template), as every other module uses.
  const { clusterId } = await envOf()
  const result = await new Promise<{ code: number, out: string }>((resolve) => {
    const child = spawn(BINARY, ['-test.run', 'TestAcc', '-test.timeout', '45m', '-test.v', '-test.count', '1'], {
      cwd: '/work/tfacc',
      env: {
        PATH: process.env.PATH, HOME: '/work', TMPDIR: '/work/tfacc',
        TF_ACC: '1', OPENVICLOUD_API_URL: API, OPENVICLOUD_TOKEN: secret, OPENVICLOUD_TEST_CLUSTER: clusterId,
      },
    })
    // Masked once at the end: a secret split across two chunks would pass a per-chunk mask.
    let raw = ''
    const take = (chunk: Buffer) => { raw += chunk.toString() }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, out: raw.split(secret).join('<token>') }))
  })
  fs.writeFileSync(`${RESULTS}/tfacc.txt`, result.out)
  for (const line of result.out.split('\n')) {
    if (/^(=== RUN|--- (PASS|FAIL|SKIP)|PASS|FAIL|ok|panic)/.test(line.trim())) {
      log(line.trim())
    }
  }
  log(`TFP exit=${result.code}`)
  expect(result.code).toBe(0)
})
