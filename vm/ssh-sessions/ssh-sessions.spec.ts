import { test } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { startLog } from './api'
import { cleanUp } from './clean-up'
import { fiveSessionsThenRefused } from './ssh'
import { RUN, createVm, deleteVmAndWait, envOf, runNetwork, runs, waitVm } from './fixtures'

// Case SSH-08 of plan.md on the release environment: a job of its own (run-module.sh … vm/ssh-sessions …), since the
// vm module runs on dev only and SSH sessions there never cross the edge in front of the release environment's API.
// The body is lib/ssh.ts fiveSessionsThenRefused, which vm/vm.spec.ts runs on dev. It counts beta-user's SSH
// sessions, so no other job that opens one (cli, cli/edge) runs beside it
// (titan-ops architecture/testing.md#regression-dev-before-candidate).
const VM_NAME = `rg-vmssh-${RUN}`
let vmId = ''

test.beforeAll(async ({ browser }) => {
  startLog('ssh-sessions')
  useBrowser(browser)
})

test.afterAll(async () => {
  test.setTimeout(10 * 60_000)
  const steps: Array<[string, () => Promise<void>]> = []
  if (vmId !== '') {
    steps.push([`delete VM ${vmId}`, () => deleteVmAndWait(vmId)])
  }
  steps.push(['sessions', closeSessions])
  await cleanUp(steps)
})

test('SSH-08 five SSH sessions open (101), the sixth is 422 VM_SESSION_LIMIT_REACHED; one opens again after they close', async () => {
  test.setTimeout(25 * 60_000)
  const { smallTier } = await envOf()
  vmId = await createVm(VM_NAME, smallTier, (await runNetwork()).id)
  await waitVm(`SSH-08 ${VM_NAME}`, vmId, (v) => runs(v))
  await fiveSessionsThenRefused(vmId, VM_NAME)
})
