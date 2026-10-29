import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { type Reply, bodyOf, call, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, runNetwork, waitVm, waitVolume } from './fixtures'

// Cases CC-01..04 of plan.md: two identical requests at the same moment. CC-03 pays the 4444 invoice
// seed-invoices.sql left on admin-test (run it before this module, as for billing).

function statusOf(reply: Reply): string {
  return `${reply.status} ${bodyOf(reply).code || ''}`.trim()
}

test.describe.serial('concurrency', () => {
  test.describe.configure({ timeout: 15 * 60_000 })

  let vmId = ''
  let volumeId = ''

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('concurrency')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    if (vmId !== '') {
      await deleteVmAndWait(vmId)
    }
    if (volumeId !== '') {
      await waitVolume('cc volume at rest', volumeId, (v) => v.transition === null || v.currentExistence === 'Deleted')
      await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`)
      await waitVolume('cc volume deleted', volumeId, (v) => v.currentExistence === 'Deleted')
    }
    await closeSessions()
  })

  // titan-ops architecture/provider-and-worker.md#provider-command-key — the second writer of the same command key
  // rolls back with 409 REQUEST_IN_PROGRESS, or arrives after the first and is answered as a repeat
  test('CC-01 two deletes of one VM at once: one 202, the other 202 or 409 REQUEST_IN_PROGRESS; one delete request', async () => {
    const { smallTier } = await envOf()
    const networkId = (await runNetwork()).id
    const name = `rg-ccvm-${RUN}`
    vmId = await createVm(name, smallTier, networkId)
    await waitVm('CC-01 has an instance', vmId, (v) => v.currentExistence === 'Exists')
    const replies = await Promise.all([
      call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`),
      call('tenant', 'DELETE', `/v1/tenant/vms/${vmId}`),
    ])
    const answers = replies.map(statusOf)
    log(`CC-01 answers: ${answers.join(' | ')}`)
    expect(answers).toContain('202')
    for (const answer of answers) {
      expect(['202', '409 REQUEST_IN_PROGRESS']).toContain(answer)
    }
    await waitVm('CC-01 deleted', vmId, (v) => v.currentExistence === 'Deleted')
    expect(countOf(await activityOf(name), 'vm.delete_requested')).toBe(1)
  })

  // titan-ops architecture/http-contract.md#idempotency-key — the second request under a key in flight is 409
  // IDEMPOTENCY_IN_PROGRESS, or replays the first one's answer
  test('CC-02 two creates with one Idempotency-Key at once make one volume', async () => {
    const { clusterId, volumeOfferingId } = await envOf()
    const name = `rg-ccvol-${RUN}`
    const key = newKey()
    const body = { name, volumeOfferingId, clusterId, sizeGb: 1 }
    const replies = await Promise.all([
      call('tenant', 'POST', '/v1/tenant/volumes', body, key),
      call('tenant', 'POST', '/v1/tenant/volumes', body, key),
    ])
    log(`CC-02 answers: ${replies.map(statusOf).join(' | ')}`)
    const ids = replies.filter((r) => r.status === 202).map((r) => bodyOf(r).volumeId as string)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(1)
    for (const reply of replies) {
      expect(['202', '409 IDEMPOTENCY_IN_PROGRESS']).toContain(statusOf(reply))
    }
    volumeId = ids[0]
    const named = (await get('tenant', '/v1/tenant/volumes') as any[]).filter((v) => v.name === name)
    expect(named.length).toBe(1)
  })

  // titan-ops architecture/money-and-wallet.md#double-pay-guard — Invoice.Status is the concurrency token
  test('CC-03 two pays of one invoice at once debit the wallet once', async () => {
    const all = await get('admin', '/v1/tenant/billing/invoices') as any[]
    const seeded = all.filter((i) => i.periodYear >= 2001 && i.periodYear < 2100 && i.total === 4444 && i.status === 'New')
    expect(seeded.length, 'run seed-invoices.sql before this module').toBeGreaterThan(0)
    const invoiceId = seeded.sort((a, b) => b.periodYear - a.periodYear)[0].id
    const before = (await get('admin', '/v1/tenant/wallet')).balance as number
    test.skip(before < 4444, `N/A: admin-test's wallet holds ${before} — run billing (BIL-11 grants) first`)
    const replies = await Promise.all([
      call('admin', 'POST', `/v1/tenant/billing/invoices/${invoiceId}/pay`),
      call('admin', 'POST', `/v1/tenant/billing/invoices/${invoiceId}/pay`),
    ])
    log(`CC-03 answers: ${replies.map(statusOf).join(' | ')}`)
    expect(replies.map(statusOf)).toContain('202')
    for (const reply of replies) {
      expect(['202', '409 INVOICE_PAYMENT_CONFLICT']).toContain(statusOf(reply))
    }
    await pollUntil('CC-03 settled', () => get('admin', `/v1/tenant/billing/invoices/${invoiceId}`),
      (i) => i.status === 'Settled', (i) => `status=${i.status} paymentState=${i.paymentState}`, 2 * 60_000, 3_000)
    await sleep(10_000)
    const after = (await get('admin', '/v1/tenant/wallet')).balance as number
    log(`CC-03 wallet ${before} → ${after}`)
    expect(before - after).toBe(4444)
  })

  // titan-ops architecture/provider-and-worker.md#provider-command-key — a new request that finds its key's command open
  // is 409 (ProviderCommandQueue.EnqueueVolumeDeleteAsync → EnqueueRequestAsync); one that arrives after the first
  // commit is a repeat
  // (OpenViCloud/titan-control-plane:Titan.Application/Commands/Compute/Volume/DeleteVolumeCommandHandler.cs HandleAsync, alreadyRequestedOrDone) answered like the first, with nothing recorded
  test('CC-04 two deletes of one volume at once: one 202, the other 202 or 409 REQUEST_IN_PROGRESS; one delete request', async () => {
    test.skip(volumeId === '', 'needs the volume of CC-02')
    const name = `rg-ccvol-${RUN}`
    await waitVolume('CC-04 volume exists at rest', volumeId, (v) => v.currentExistence === 'Exists' && v.transition === null)
    const replies = await Promise.all([
      call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`),
      call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`),
    ])
    const answers = replies.map(statusOf)
    log(`CC-04 answers: ${answers.join(' | ')}`)
    expect(answers).toContain('202')
    for (const answer of answers) {
      expect(['202', '409 REQUEST_IN_PROGRESS']).toContain(answer)
    }
    await waitVolume('CC-04 deleted', volumeId, (v) => v.currentExistence === 'Deleted')
    expect(countOf(await activityOf(name), 'volume.delete_requested')).toBe(1)
  })
})
