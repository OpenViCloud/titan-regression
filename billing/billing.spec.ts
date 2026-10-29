import { test, expect } from '@playwright/test'
import { closeSessions, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { RUN, createVm, deleteVmAndWait, envOf, runNetwork, runs, waitVm, waitVolume } from './fixtures'

// Cases BIL-01..08 and BIL-10..13, BIL-15 of plan.md. Money moves only on admin-test's tenant, through
// invoices seed-invoices.sql made before this job (the agent runs it); BIL-14 is check-wallets.sql, run after.
// Usage (BIL-01..03) is metered on the lane's tenant (beta-user-2 in lane b): metering moves no money.

// OpenViCloud/titan-control-plane:Titan.Application/Options/BillingMeterOptions.cs (IntervalMinutes) — one tick every 10 minutes by default
const TICK_MS = 10 * 60_000

// A usage record keeps the raw product; whole VND happens once, on the invoice line
// (titan-ops architecture/money-and-wallet.md#round-once). Any size bills; 10 GB makes the storage step easy to read in the log.
const BILLED_GB = 10

type Invoice = { id: string, status: string, total: number, paymentState: string | null, paidBy: string | null }

function invoiceShape(i: Invoice): string {
  return `status=${i.status} paymentState=${i.paymentState} paidBy=${i.paidBy}`
}

test.describe.serial('billing', () => {
  test.describe.configure({ timeout: 40 * 60_000 })

  let seedYear = 0
  const invoices: Record<number, string> = {}
  let vmId = ''
  let volumeId = ''

  async function wallet(): Promise<number> {
    return (await get('admin', '/v1/tenant/wallet')).balance as number
  }

  async function readInvoice(total: number): Promise<Invoice> {
    return await get('admin', `/v1/tenant/billing/invoices/${invoices[total]}`) as Invoice
  }

  async function waitWallet(label: string, expected: number): Promise<void> {
    await pollUntil(label, () => wallet(), (b) => b === expected, (b) => `balance=${b}`, 2 * 60_000, 3_000)
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    startLog('billing')
    useBrowser(browser)
    // The newest seed year below 2100 is the one seed-invoices.sql just wrote.
    const all = await get('admin', '/v1/tenant/billing/invoices') as Array<Invoice & { periodYear: number, periodMonth: number }>
    const seeded = all.filter((i) => i.periodYear >= 2001 && i.periodYear < 2100)
    expect(seeded.length, 'run seed-invoices.sql before this module').toBeGreaterThan(0)
    seedYear = Math.max(...seeded.map((i) => i.periodYear))
    for (const invoice of seeded.filter((i) => i.periodYear === seedYear)) {
      invoices[invoice.total] = invoice.id
    }
    log(`seed year ${seedYear}: ${JSON.stringify(invoices)}`)
    for (const total of [1111, 900000000, 2222, 3333, 4444]) {
      expect(invoices[total], `seeded invoice of ${total}`).toBeDefined()
    }
  })

  test.afterAll(async () => {
    test.setTimeout(10 * 60_000)
    if (vmId !== '') {
      await deleteVmAndWait(vmId)
    }
    if (volumeId !== '') {
      const snaps = await get('tenant', `/v1/tenant/volumes/${volumeId}/snapshots`) as any[]
      for (const snap of snaps) {
        await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}/snapshots/${snap.id}`)
      }
      await pollUntil('billing snapshots gone', () => get('tenant', `/v1/tenant/volumes/${volumeId}/snapshots`) as Promise<any[]>,
        (rows) => rows.length === 0, (rows) => `${rows.length} left`)
      expectStatus(await call('tenant', 'DELETE', `/v1/tenant/volumes/${volumeId}`), 202)
      await waitVolume('billing volume deleted', volumeId, (v) => v.currentExistence === 'Deleted')
    }
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/GrantTopUpAdminEndpoint.cs (Configure: Post("v1/admin/topups/grant"),
  // Roles("platform-admin"); HandleAsync: SendAsync(result, 201))
  test('BIL-11 admin grants promo credit: 201 {topUpId}, the wallet grows by it, a Promo line', async () => {
    const tenant = await get('admin', '/v1/tenant')
    const before = await wallet()
    const reply = await call('admin', 'POST', '/v1/admin/topups/grant', { tenantId: tenant.id, amount: 50000, reason: `rg-billing-${RUN}` }, newKey())
    expectStatus(reply, 201)
    expect(Object.keys(bodyOf(reply))).toEqual(['topUpId'])
    await waitWallet('BIL-11', before + 50000)
    const statement = await get('admin', '/v1/tenant/wallet/statement')
    const promos = statement.lines.filter((l: any) => l.type === 'Promo' && l.amount === 50000).length
    log(`BIL-11 Promo lines of 50000: ${promos}; types seen: ${[...new Set(statement.lines.map((l: any) => l.type))].join(',')}`)
    expect(promos).toBeGreaterThan(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/CreateTopUpEndpoint.cs (CreateTopUpEndpoint);
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/ConfirmTopUpAdminEndpoint.cs (Configure: Post("v1/admin/topups/{id:guid}/confirm"),
  // Roles("platform-admin"); HandleAsync: 202);
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Billing/TopUp/TopUpConfirmation.cs ConfirmAsync (already Confirmed ⇒ return) — a repeat credits nothing
  test('BIL-10 a top-up confirmed by admin credits the wallet once; a second confirm is a 202 no-op', async () => {
    const before = await wallet()
    const reply = await call('admin', 'POST', '/v1/tenant/topups', { amount: 10000 }, newKey())
    expectStatus(reply, 201)
    const topUpId = bodyOf(reply).topUpId as string
    const confirm = await call('admin', 'POST', `/v1/admin/topups/${topUpId}/confirm`, {})
    expectStatus(confirm, 202)
    expect(confirm.text).toBe('')
    await waitWallet('BIL-10', before + 10000)
    expectStatus(await call('admin', 'POST', `/v1/admin/topups/${topUpId}/confirm`, {}), 202)
    await sleep(10_000)
    expect(await wallet()).toBe(before + 10000)
    const mine = await get('admin', '/v1/tenant/topups') as any[]
    expect(mine.find((t) => t.id === topUpId).status).toBe('Confirmed')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Billing/Invoice/InvoiceWalletSettlement.cs (SettleAsync); the consumer applies
  // the debit later (titan-ops features/billing/invoice/design.md#pay-routes)
  test('BIL-04 the tenant pays an invoice from a wallet that covers it: 202, then Settled and debited once', async () => {
    const before = await wallet()
    const debitsBefore = (await get('admin', '/v1/tenant/wallet/statement')).lines.filter((l: any) => l.amount === -1111).length
    const reply = await call('admin', 'POST', `/v1/tenant/billing/invoices/${invoices[1111]}/pay`)
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    const settled = await pollUntil('BIL-04', () => readInvoice(1111), (i) => i.status === 'Settled', invoiceShape, 2 * 60_000, 3_000)
    expect(settled.paymentState).toBe('Settled')
    await waitWallet('BIL-04 wallet', before - 1111)
    const statement = await get('admin', '/v1/tenant/wallet/statement')
    // One more debit of this amount, not "one in total": the wallet is long-lived and earlier runs paid 1111 too.
    expect(statement.lines.filter((l: any) => l.amount === -1111).length).toBe(debitsBefore + 1)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Billing/Invoice/InvoiceWalletSettlement.cs IsAlreadyPaidFromWalletAsync — the wallet already paid it
  test('BIL-05 paying it again is 202 and debits nothing', async () => {
    const before = await wallet()
    expectStatus(await call('admin', 'POST', `/v1/tenant/billing/invoices/${invoices[1111]}/pay`), 202)
    await sleep(10_000)
    expect(await wallet()).toBe(before)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Services/Billing/Invoice/InvoiceWalletSettlement.cs SettleAsync (INVOICE_WALLET_INSUFFICIENT)
  test('BIL-06 an invoice larger than the wallet is 422 INVOICE_WALLET_INSUFFICIENT and the wallet is unchanged', async () => {
    const before = await wallet()
    expectError(await call('admin', 'POST', `/v1/tenant/billing/invoices/${invoices[900000000]}/pay`), 422, 'INVOICE_WALLET_INSUFFICIENT')
    expect(await wallet()).toBe(before)
    expect((await readInvoice(900000000)).status).toBe('New')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Billing/SettleInvoiceFromWalletAdminEndpoint.cs (Configure: Post("v1/admin/invoices/{invoiceId:guid}/settle-from-wallet"),
  // Roles("platform-admin"); HandleAsync: 202)
  test('BIL-07 admin settles an invoice from the tenant wallet: 202, then Settled and the wallet pays it', async () => {
    const before = await wallet()
    const reply = await call('admin', 'POST', `/v1/admin/invoices/${invoices[2222]}/settle-from-wallet`)
    expectStatus(reply, 202)
    expect(reply.text).toBe('')
    await pollUntil('BIL-07', () => readInvoice(2222), (i) => i.status === 'Settled', invoiceShape, 2 * 60_000, 3_000)
    await waitWallet('BIL-07 wallet', before - 2222)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/Invoice/MarkInvoicePaidCommandHandler.cs HandleAsync (alreadyMarkedPaid: repeat),
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Billing/Invoice/Invoice.cs MarkPaid (INVOICE_ALREADY_PAID: paid by the wallet already)
  test('BIL-08 MarkPaid is 204 and touches no wallet; a repeat is 204; on a wallet-settled invoice 422 INVOICE_ALREADY_PAID', async () => {
    const before = await wallet()
    const reply = await call('admin', 'PATCH', `/v1/admin/invoices/${invoices[3333]}/pay`)
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    const paid = await readInvoice(3333)
    expect(paid.status).toBe('Paid')
    expectStatus(await call('admin', 'PATCH', `/v1/admin/invoices/${invoices[3333]}/pay`), 204)
    expect(await wallet()).toBe(before)
    expectError(await call('admin', 'PATCH', `/v1/admin/invoices/${invoices[1111]}/pay`), 422, 'INVOICE_ALREADY_PAID')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Billing/GetReceivablesAdminEndpoint.cs (Configure, Roles("platform-admin"));
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Billing/Invoice/Contracts/TenantReceivableLine.cs (TenantReceivableLine)
  test('BIL-15 receivables carry debtCeiling and overCeiling for admin-test, who still owes the large invoice', async () => {
    const tenant = await get('admin', '/v1/tenant')
    const receivables = await get('admin', '/v1/admin/billing/receivables')
    const line = receivables.perTenant.find((l: any) => l.tenantId === tenant.id)
    log(`BIL-15 ${JSON.stringify(line)}`)
    expect(line.outstanding).toBeGreaterThanOrEqual(900000000)
    expect(line.debtCeiling).toBe(tenant.debtCeiling)
    expect(line.overCeiling).toBe(line.outstanding > line.debtCeiling)
  })

  // titan-ops features/billing/topup/design.md#topup-routes — the old routes are gone
  test('BIL-12 removed wallet routes answer 404', async () => {
    expectStatus(await call('admin', 'GET', '/v1/tenant/wallet/receipts'), 404)
    expectStatus(await call('admin', 'GET', '/v1/tenant/wallet/topups'), 404)
  })

  // OpenViCloud/titan-control-plane:Titan.Host/Program.cs (MapHealthChecks("/healthz/wallet"))
  test('BIL-13 /healthz/wallet is Healthy', async () => {
    const reply = await call('anonymous', 'GET', '/healthz/wallet')
    log(`BIL-13 ${reply.status} ${reply.text.slice(0, 200)}`)
    expectStatus(reply, 200)
  })

  // Metering, on the lane's tenant (no money moves). OpenViCloud/titan-control-plane:Titan.Infrastructure/Repositories/VmRepository.cs
  // ListBillableAsync — Running, Ready, Frozen, Error are billed; Stopped is not (titan-ops features/vm/design.md#counting-and-billing)
  test('BIL-01..03 a running VM gets RUNNING_VM usage at the tier price, a 10 GB volume gets storage usage, a stopped VM gets no more', async () => {
    const { smallTier, clusterId, volumeOfferingId } = await envOf()
    const networkId = (await runNetwork()).id
    vmId = await createVm(`rg-billvm-${RUN}`, smallTier, networkId)
    await waitVm('BIL-01 vm runs', vmId, runs)
    const volumeReply = await call('tenant', 'POST', '/v1/tenant/volumes', { name: `rg-billvol-${RUN}`, volumeOfferingId, clusterId, sizeGb: BILLED_GB }, newKey())
    expectStatus(volumeReply, 202)
    volumeId = bodyOf(volumeReply).volumeId
    await waitVolume('BIL-02 volume', volumeId, (v) => v.currentExistence === 'Exists' && v.transition === null)
    const storageBefore = (await get('tenant', '/v1/tenant/billing/summary')).storageCost as number

    const cost = await pollUntil('BIL-01 compute usage', () => get('tenant', `/v1/tenant/vms/${vmId}/cost`),
      (c) => c.breakdown.length > 0, (c) => `lines=${c.breakdown.length} total=${c.totalCost}`, 2 * TICK_MS + 2 * 60_000, 30_000)
    // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Billing/UsageRecord/UsageRecord.cs (UsageRecord) — a running VM's line; one tick
    // costs the tier's hourly price × tick/60, not rounded (titan-ops architecture/money-and-wallet.md#round-once)
    expect(cost.breakdown.every((l: any) => l.usageType === 'RUNNING_VM')).toBe(true)
    const price = (await get('anonymous', '/v1/vm-offerings') as any[]).find((o) => o.id === smallTier).pricePerHour as number
    log(`BIL-01 first line ${JSON.stringify(cost.breakdown[0])}, price/h ${price}`)
    expect(cost.breakdown[0].cost).toBeCloseTo(price * (TICK_MS / 60_000) / 60, 6)

    // BIL-03: the summary's line for this VM is the VM's cost.
    const summary = await get('tenant', '/v1/tenant/billing/summary')
    const line = summary.perVm.find((l: any) => l.vmId === vmId)
    expect(line.totalCost).toBe(cost.totalCost)

    // BIL-02: storage usage grew once the volume existed through a tick.
    const diskPrice = (await get('anonymous', '/v1/volume-offerings') as any[]).find((o) => o.id === volumeOfferingId).pricePerGbPerHour as number
    const perTick = diskPrice * BILLED_GB * (TICK_MS / 60_000) / 60
    log(`BIL-02 disk ${diskPrice}/GB/h × ${BILLED_GB} GB ⇒ ${perTick} ₫ a tick`)
    expect(perTick).toBeGreaterThan(0)
    const storage = await pollUntil('BIL-02 storage usage', () => get('tenant', '/v1/tenant/billing/summary'),
      (s) => s.storageCost > storageBefore, (s) => `storage=${s.storageCost}`, 2 * TICK_MS + 2 * 60_000, 30_000)
    // Both sides are raw decimals read as JSON numbers; the tolerance only absorbs float noise.
    expect(storage.storageCost - storageBefore).toBeGreaterThanOrEqual(perTick - 1e-6)

    expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/stop`), 202)
    await waitVm('BIL-01 vm stopped', vmId, (v) => v.currentState === 'Stopped' && v.transition === null)
    // A tick may already have sampled the VM while it ran; give it one tick to land, then a full tick stopped.
    await sleep(TICK_MS)
    const stoppedAt = (await get('tenant', `/v1/tenant/vms/${vmId}/cost`)).breakdown.length
    await sleep(TICK_MS + 60_000)
    const after = (await get('tenant', `/v1/tenant/vms/${vmId}/cost`)).breakdown.length
    log(`BIL-01 stopped: lines ${stoppedAt} → ${after}`)
    expect(after).toBe(stoppedAt)
  })
})
