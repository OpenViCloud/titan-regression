import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { closeSessions, headersOf, useBrowser } from './auth'
import { bodyOf, call, expectError, expectStatus, get, log, newKey, pollUntil, sleep, startLog } from './api'
import { RUN, createVm, deleteVmAndWait, envOf, runNetwork, runs, waitVm, waitVolume } from './fixtures'
import { callWithToken } from './token'

// Cases BIL-01..13, BIL-15, BIL-17 and BIL-19..23 of plan.md. Money moves only on admin-test's tenant, through
// invoices seed-invoices.sql made before this job (the agent runs it); BIL-14 is check-wallets.sql, run after.
// Usage (BIL-01..03, BIL-19) is metered on the lane's tenant (beta-user-2 in lane b): metering moves no money; the
// lane's tenant only reads invoices (BIL-17) and is refused on admin-test's (BIL-20).

// OpenViCloud/titan-control-plane:Titan.Application/Options/BillingMeterOptions.cs (IntervalMinutes) — one tick every 10 minutes by default
const TICK_MS = 10 * 60_000

// A usage record keeps the raw product; whole VND happens once, on the invoice line
// (titan-ops architecture/money-and-wallet.md#round-once). Any size bills; 10 GB makes the storage step easy to read in the log.
const BILLED_GB = 10

type Invoice = {
  id: string, tenantId: string, status: string, total: number, paymentState: string | null, paidBy: string | null,
  paidAt: string | null, issuedAt: string, dueAt: string, periodYear: number, periodMonth: number, currency: string,
}

type TopUp = { id: string, status: string, source: string | null, amount: number, paymentRef: string }

function invoiceShape(i: Invoice): string {
  return `status=${i.status} paymentState=${i.paymentState} paidBy=${i.paidBy}`
}

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/UsageRecord/UsageRecord.cs (TotalVnd) —
// Math.Round(raw, MidpointRounding.AwayFromZero), once, on the sum of an invoice line.
function roundHalfAwayFromZero(raw: number): number {
  return Math.sign(raw) * Math.floor(Math.abs(raw) + 0.5)
}

// The UTC month before `now`, as the summary's `month` query and the invoice's period.
function previousUtcMonth(now: Date): { year: number, month: number, query: string } {
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth() // 0-based this month = 1-based previous month
  if (month === 0) {
    year -= 1
    month = 12
  }
  return { year, month, query: `${year}-${String(month).padStart(2, '0')}` }
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

test.describe.serial('billing', () => {
  test.describe.configure({ timeout: 40 * 60_000 })

  let seedYear = 0
  const invoices: Record<number, string> = {}
  let vmId = ''
  let volumeId = ''
  // Read by later cases: the top-ups of BIL-11 (promo) and BIL-10 (admin-confirmed) for BIL-23, the VM's cost and
  // month as BIL-03 read them for BIL-19.
  let promoTopUpId = ''
  let manualTopUpId = ''
  let vmCostAtBil03 = 0
  let vmMonthAtBil03 = ''

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
    promoTopUpId = bodyOf(reply).topUpId as string
    await waitWallet('BIL-11', before + 50000)
    const statement = await get('admin', '/v1/tenant/wallet/statement')
    const promos = statement.lines.filter((l: any) => l.type === 'Promo' && l.amount === 50000).length
    log(`BIL-11 Promo lines of 50000: ${promos}; types seen: ${[...new Set(statement.lines.map((l: any) => l.type))].join(',')}`)
    expect(promos).toBeGreaterThan(0)
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/CreateTopUpEndpoint.cs (CreateTopUpEndpoint);
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/ConfirmTopUpAdminEndpoint.cs (Configure: Post("v1/admin/topups/{id:guid}/confirm"),
  // Roles("platform-admin"); HandleAsync: 202);
  // OpenViCloud/titan-control-plane:Titan.Application/Services/Billing/TopUp/TopUpConfirmation.cs ConfirmAsync (already Confirmed ⇒ return) — a repeat credits nothing.
  // Webhook: OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Payments/SePayWebhookEndpoint.cs (HandleAsync: SePayApiKeyAuth.Matches
  // fails ⇒ SendUnauthorizedAsync, before the body is read) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Payments/SePayApiKeyAuth.cs
  // (Matches: only "Apikey <the configured key>"; a JWT never passes) · titan-ops features/billing/topup/design.md#sepay-flow.
  // A body that would match the top-up (its paymentRef, its amount) is the point: a broken key check would confirm it.
  // prd's tunnel sends the whole api host to the control plane, /internal included, so the webhook is reachable here.
  test('BIL-10 a top-up confirmed by admin credits the wallet once; a second confirm is a 202 no-op; the SePay webhook refuses a missing, wrong or JWT credential', async () => {
    const before = await wallet()
    const reply = await call('admin', 'POST', '/v1/tenant/topups', { amount: 10000 }, newKey())
    expectStatus(reply, 201)
    const topUpId = bodyOf(reply).topUpId as string
    manualTopUpId = topUpId

    const pending = (await get('admin', '/v1/tenant/topups') as TopUp[]).find((t) => t.id === topUpId)!
    expect(pending.status).toBe('Pending')
    const webhook = '/internal/payments/sepay/webhook'
    const body = {
      id: Math.floor(Math.random() * 1_000_000_000) + 1,
      gateway: 'rg',
      transactionDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
      transferType: 'in',
      transferAmount: pending.amount,
      content: pending.paymentRef,
      code: pending.paymentRef,
    }
    log(`BIL-10 webhook body id=${body.id} amount=${body.transferAmount} ref=${body.code}`)
    expectStatus(await call('anonymous', 'POST', webhook, body), 401)
    expectStatus(await callWithToken(`rg-wrong-${RUN}`, 'POST', webhook, body, undefined, 'Apikey'), 401)
    const jwt = (await headersOf('admin')).Authorization.slice('Bearer '.length)
    expectStatus(await callWithToken(jwt, 'POST', webhook, body, undefined, 'Bearer'), 401)
    const after = (await get('admin', '/v1/tenant/topups') as TopUp[]).find((t) => t.id === topUpId)!
    expect(after.status).toBe('Pending')
    expect(after.source).toBeNull()
    expect(await wallet()).toBe(before)

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

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/ListTopUpsAdminEndpoint.cs (HandleAsync: Enum.TryParse + Enum.IsDefined,
  // else SendErrorsAsync(400) ⇒ VALIDATION_ERROR by the error ResponseBuilder of OpenViCloud/titan-control-plane:Titan.Host/Program.cs);
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/TopUp/ConfirmTopUpCommandHandler.cs (HandleAsync: TopUpSource.Manual) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/TopUp/TopUp.cs (GrantPromo: TopUpSource.PromotionalCredit) ·
  // titan-ops features/billing/topup/design.md#topup-routes · titan-ops features/billing/topup/user-stories.md#us-promo-01
  test('BIL-23 admin top-ups filter by source: PromotionalCredit has the grant, Manual the confirmed top-up, an unknown source is 400', async () => {
    expect(promoTopUpId, 'the promo grant of this run').not.toBe('')
    expect(manualTopUpId, 'the admin-confirmed top-up of this run').not.toBe('')
    const promo = await get('admin', '/v1/admin/topups?source=PromotionalCredit') as TopUp[]
    log(`BIL-23 PromotionalCredit rows=${promo.length} sources=${[...new Set(promo.map((t) => t.source))].join(',')}`)
    expect(promo.every((t) => t.source === 'PromotionalCredit')).toBe(true)
    expect(promo.some((t) => t.id === promoTopUpId)).toBe(true)
    expect(promo.some((t) => t.id === manualTopUpId)).toBe(false)
    const manual = await get('admin', '/v1/admin/topups?source=Manual') as TopUp[]
    log(`BIL-23 Manual rows=${manual.length} sources=${[...new Set(manual.map((t) => t.source))].join(',')}`)
    expect(manual.every((t) => t.source === 'Manual')).toBe(true)
    expect(manual.some((t) => t.id === manualTopUpId)).toBe(true)
    expectError(await call('admin', 'GET', '/v1/admin/topups?source=9'), 400, 'VALIDATION_ERROR')
    expectError(await call('admin', 'GET', '/v1/admin/topups?source=khong-co'), 400, 'VALIDATION_ERROR')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/CreateTopUpEndpoint.cs (RequestTopUpValidator: Amount > 0);
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/TopUp/GrantTopUpAdminEndpoint.cs (GrantTopUpValidator: Amount > 0);
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/TopUp/GrantTopUpCommandHandler.cs (HandleAsync: amount > MaxGrantAmount ⇒
  // GRANT_AMOUNT_EXCEEDS_MAX) · OpenViCloud/titan-control-plane:Titan.Application/Options/CreditOptions.cs (MaxGrantAmount = 100_000_000; no
  // Credit__MaxGrantAmount in the control plane's base or prd manifests) · titan-ops features/billing/topup/design.md#promo-grant
  test('BIL-22 a top-up of 0 or less is 400, a grant above the cap is 422 GRANT_AMOUNT_EXCEEDS_MAX, a grant of 0 is 400; nothing is added', async () => {
    const tenant = await get('admin', '/v1/tenant')
    const before = await wallet()
    const topUpsBefore = (await get('admin', '/v1/tenant/topups') as TopUp[]).length
    const grantsBefore = (await get('admin', '/v1/admin/topups?source=PromotionalCredit') as TopUp[]).length
    expectError(await call('admin', 'POST', '/v1/tenant/topups', { amount: 0 }, newKey()), 400, 'VALIDATION_ERROR')
    expectError(await call('admin', 'POST', '/v1/tenant/topups', { amount: -1000 }, newKey()), 400, 'VALIDATION_ERROR')
    expect((await get('admin', '/v1/tenant/topups') as TopUp[]).length).toBe(topUpsBefore)
    expectError(await call('admin', 'POST', '/v1/admin/topups/grant',
      { tenantId: tenant.id, amount: 100000001, reason: `rg-billing-${RUN}` }, newKey()), 422, 'GRANT_AMOUNT_EXCEEDS_MAX')
    expectError(await call('admin', 'POST', '/v1/admin/topups/grant',
      { tenantId: tenant.id, amount: 0, reason: `rg-billing-${RUN}` }, newKey()), 400, 'VALIDATION_ERROR')
    expect(await wallet()).toBe(before)
    expect((await get('admin', '/v1/admin/topups?source=PromotionalCredit') as TopUp[]).length).toBe(grantsBefore)
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

  // OpenViCloud/titan-control-plane:Titan.Domain/Services/InvoiceWalletPayment.cs RequestAsync (INVOICE_WALLET_INSUFFICIENT)
  test('BIL-06 an invoice larger than the wallet is 422 INVOICE_WALLET_INSUFFICIENT and the wallet is unchanged', async () => {
    const before = await wallet()
    expectError(await call('admin', 'POST', `/v1/tenant/billing/invoices/${invoices[900000000]}/pay`), 422, 'INVOICE_WALLET_INSUFFICIENT')
    expect(await wallet()).toBe(before)
    expect((await readInvoice(900000000)).status).toBe('New')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Billing/Invoice/GetTenantInvoiceQueryHandler.cs (HandleAsync) and
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/Invoice/PayInvoiceFromWalletCommandHandler.cs (HandleAsync): another
  // tenant's invoice and a missing one are the same INVOICE_NOT_FOUND; OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Billing/SettleInvoiceFromWalletAdminEndpoint.cs
  // and OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Billing/MarkInvoicePaidEndpoint.cs (Configure: Roles("platform-admin")) ⇒ 403;
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/Invoice/SettleInvoiceFromWalletCommandHandler.cs (HandleAsync) and
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/Invoice/MarkInvoicePaidCommandHandler.cs (HandleAsync): unknown id ⇒ INVOICE_NOT_FOUND ·
  // titan-ops features/billing/invoice/design.md#pay-routes. The 900000000 invoice is more than admin-test's wallet holds, so even a broken
  // gate could not move money.
  test('BIL-20 the lane tenant cannot read, pay or settle an admin-test invoice; unknown invoice ids are 404 INVOICE_NOT_FOUND', async () => {
    const before = await wallet()
    const foreign = invoices[900000000]
    const unknown = randomUUID()
    expectError(await call('tenant', 'GET', `/v1/tenant/billing/invoices/${foreign}`), 404, 'INVOICE_NOT_FOUND')
    expectError(await call('tenant', 'POST', `/v1/tenant/billing/invoices/${foreign}/pay`), 404, 'INVOICE_NOT_FOUND')
    expectStatus(await call('tenant', 'POST', `/v1/admin/invoices/${foreign}/settle-from-wallet`), 403)
    expectStatus(await call('tenant', 'PATCH', `/v1/admin/invoices/${foreign}/pay`), 403)
    expectError(await call('tenant', 'GET', `/v1/tenant/billing/invoices/${unknown}`), 404, 'INVOICE_NOT_FOUND')
    expectError(await call('tenant', 'POST', `/v1/tenant/billing/invoices/${unknown}/pay`), 404, 'INVOICE_NOT_FOUND')
    expectError(await call('admin', 'POST', `/v1/admin/invoices/${unknown}/settle-from-wallet`), 404, 'INVOICE_NOT_FOUND')
    expectError(await call('admin', 'PATCH', `/v1/admin/invoices/${unknown}/pay`), 404, 'INVOICE_NOT_FOUND')
    const large = await readInvoice(900000000)
    log(`BIL-20 900000000: ${invoiceShape(large)}`)
    expect(['New', 'Overdue']).toContain(large.status)
    expect(large.paymentState).toBeNull()
    expect(await wallet()).toBe(before)
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
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Invoice/Invoice.cs MarkPaid (INVOICE_ALREADY_PAID: paid by the wallet already);
  // the tenant's pay on a marked-paid invoice: OpenViCloud/titan-control-plane:Titan.Application/Services/Billing/Invoice/InvoiceWalletSettlement.cs
  // (IsAlreadyPaidFromWalletAsync: Paid is not a repeat) ⇒ OpenViCloud/titan-control-plane:Titan.Domain/Services/InvoiceWalletPayment.cs
  // (RequestAsync: Status ≠ New ⇒ INVOICE_INVALID_STATE, before any debit row) · titan-ops architecture/money-and-wallet.md#human-confirmed-debit
  test('BIL-08 MarkPaid is 204 and touches no wallet; a repeat is 204; on a wallet-settled invoice 422 INVOICE_ALREADY_PAID; the tenant paying it is 422 INVOICE_INVALID_STATE', async () => {
    const before = await wallet()
    const reply = await call('admin', 'PATCH', `/v1/admin/invoices/${invoices[3333]}/pay`)
    expectStatus(reply, 204)
    expect(reply.text).toBe('')
    const paid = await readInvoice(3333)
    expect(paid.status).toBe('Paid')
    expectStatus(await call('admin', 'PATCH', `/v1/admin/invoices/${invoices[3333]}/pay`), 204)
    expect(await wallet()).toBe(before)
    expectError(await call('admin', 'PATCH', `/v1/admin/invoices/${invoices[1111]}/pay`), 422, 'INVOICE_ALREADY_PAID')
    expectError(await call('admin', 'POST', `/v1/tenant/billing/invoices/${invoices[3333]}/pay`), 422, 'INVOICE_INVALID_STATE')
    expect(await wallet()).toBe(before)
    const still = await readInvoice(3333)
    expect(still.status).toBe('Paid')
    expect(still.paymentState).toBeNull()
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

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Invoice/Invoice.cs (DisplayStatus: Overdue = New past DueAt, read time; Paid and
  // Settled never Overdue) · OpenViCloud/titan-control-plane:Titan.Application/Queries/Billing/Invoice/ListInvoicesQueryHandler.cs (HandleAsync:
  // ?status filters the derived status) · OpenViCloud/titan-control-plane:Titan.Application/Queries/Billing/Invoice/GetReceivablesQueryHandler.cs
  // (HandleAsync: Status New only, overdue by DisplayStatus) · titan-ops features/billing/invoice/design.md#invoice-statuses ·
  // titan-ops features/billing/invoice/design.md#receivables. The three reads are seconds apart; an invoice whose dueAt falls within a
  // minute of them may change status between reads, so it is left out of the status checks and allowed either way in the counts.
  test('BIL-21 unpaid invoices past dueAt read Overdue on every route, and receivables count exactly them for admin-test', async () => {
    const tenant = await get('admin', '/v1/tenant')
    const from = Date.now() - MINUTE_MS
    const mine = await get('admin', '/v1/tenant/billing/invoices') as Invoice[]
    const overdueListed = (await get('admin', '/v1/admin/invoices?status=Overdue') as Invoice[]).filter((i) => i.tenantId === tenant.id)
    const receivables = await get('admin', '/v1/admin/billing/receivables')
    const to = Date.now() + MINUTE_MS
    const near = (i: Invoice) => Date.parse(i.dueAt) >= from && Date.parse(i.dueAt) <= to
    const unpaid = mine.filter((i) => i.status === 'New' || i.status === 'Overdue')
    const settled = mine.filter((i) => i.status === 'Paid' || i.status === 'Settled')
    expect(unpaid.length + settled.length, 'every status is New, Overdue, Paid or Settled').toBe(mine.length)
    const pastDue = unpaid.filter((i) => !near(i) && Date.parse(i.dueAt) < from)
    const notDue = unpaid.filter((i) => !near(i) && Date.parse(i.dueAt) > to)
    const boundary = unpaid.filter(near)
    log(`BIL-21 admin-test invoices=${mine.length} unpaid=${unpaid.length} pastDue=${pastDue.length} notDue=${notDue.length} boundary=${boundary.length}`)
    test.skip(pastDue.length === 0, 'no unpaid invoice of admin-test is past its dueAt yet: nothing can read Overdue')

    expect(pastDue.filter((i) => i.status !== 'Overdue').map((i) => `${i.id} ${i.status} due ${i.dueAt}`)).toEqual([])
    expect(notDue.filter((i) => i.status !== 'New').map((i) => `${i.id} ${i.status} due ${i.dueAt}`)).toEqual([])
    expect(settled.every((i) => i.paidAt !== null)).toBe(true)

    const boundaryIds = new Set(boundary.map((i) => i.id))
    const listedIds = overdueListed.map((i) => i.id).filter((id) => !boundaryIds.has(id)).sort()
    expect(listedIds).toEqual(pastDue.map((i) => i.id).sort())

    const line = receivables.perTenant.find((l: any) => l.tenantId === tenant.id)
    log(`BIL-21 receivables ${JSON.stringify(line)} totalOverdue=${receivables.totalOverdue}`)
    const sum = (rows: Invoice[]) => rows.reduce((s, i) => s + i.total, 0)
    expect(line.invoiceCount).toBe(unpaid.length)
    expect(line.outstanding).toBe(sum(unpaid))
    expect(Date.parse(line.oldestDueAt)).toBe(Math.min(...unpaid.map((i) => Date.parse(i.dueAt))))
    expect(line.overdueCount).toBeGreaterThanOrEqual(pastDue.length)
    expect(line.overdueCount).toBeLessThanOrEqual(pastDue.length + boundary.length)
    if (boundary.length === 0) {
      expect(line.overdueAmount).toBe(sum(pastDue))
    } else {
      expect(line.overdueAmount).toBeGreaterThanOrEqual(sum(pastDue))
      expect(line.overdueAmount).toBeLessThanOrEqual(sum(pastDue) + sum(boundary))
    }
    expect(receivables.totalOverdue).toBeGreaterThanOrEqual(line.overdueAmount)
  })

  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Invoice/Invoice.cs (Generate: Total == 0 ⇒ Paid, PaidAt = issuedAt, PaidBy = "system";
  // no wallet debit) · OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/Invoice/GenerateInvoicesForPeriodCommandHandler.cs (HandleAsync:
  // only tenants with usage in the period) · titan-ops features/billing/invoice/design.md#invoice-statuses.
  // NOT COVERED when no such invoice exists (plan.md: the runner cannot make a period whose every line rounds to 0;
  // OpenViCloud/titan-control-plane:Titan.Tests/Services/InvoiceServiceTests.cs (Generate_ZeroTotal_AutoSettles_AsPaidBySystem_NotByWallet) guards it).
  test('BIL-09 every 0 ₫ invoice is Paid by system at its issue time, with no payment state', async () => {
    const zero = (await get('admin', '/v1/admin/invoices') as Invoice[]).filter((i) => i.total === 0)
    log(`BIL-09 zero-total invoices: ${zero.length}`)
    test.skip(zero.length === 0, 'NOT COVERED: no invoice with total 0 exists on this environment')
    for (const invoice of zero) {
      log(`BIL-09 ${invoice.id} ${invoiceShape(invoice)} paidAt=${invoice.paidAt} issuedAt=${invoice.issuedAt}`)
      expect(invoice.status).toBe('Paid')
      expect(invoice.paidBy).toBe('system')
      expect(Date.parse(invoice.paidAt!)).toBe(Date.parse(invoice.issuedAt))
      expect(invoice.paymentState).toBeNull()
    }
  })

  // titan-ops features/billing/topup/design.md#topup-routes (Không còn: every one of these is 404) · titan-ops features/catalog/user-stories.md#pr-5
  // (pricing rules removed) · titan-ops features/billing/invoice/design.md#billing-routes ·
  // OpenViCloud/titan-control-plane:Titan.Tests/Api/TopUpRouteContractTests.cs (OldTopUpRoutes_AreGone_404): no endpoint matches ⇒ 404 before
  // any handler, so the bodies below (a promo of 1 ₫ to admin-test) could never run. The wallet staying put is the check that they did not.
  test('BIL-12 removed wallet, top-up, promo and pricing-rule routes answer 404 and the admin-test wallet does not move', async () => {
    const tenant = await get('admin', '/v1/tenant')
    const before = await wallet()
    const unknown = randomUUID()
    expectStatus(await call('admin', 'GET', '/v1/tenant/wallet/receipts'), 404)
    expectStatus(await call('admin', 'GET', '/v1/tenant/wallet/topups'), 404)
    expectStatus(await call('admin', 'POST', '/v1/tenant/wallet/topups', { amount: 1000 }), 404)
    expectStatus(await call('admin', 'POST', `/v1/admin/wallet/topups/${unknown}/confirm`, {}), 404)
    expectStatus(await call('admin', 'GET', '/v1/admin/promotional-credits'), 404)
    expectStatus(await call('admin', 'POST', '/v1/admin/promotional-credits', { tenantId: tenant.id, amount: 1, reason: `rg-billing-${RUN}` }), 404)
    expectStatus(await call('admin', 'GET', `/v1/tenant/wallet/receipts/${unknown}`), 404)
    expectStatus(await call('admin', 'GET', '/v1/admin/pricing-rules'), 404)
    expectStatus(await call('admin', 'POST', '/v1/admin/pricing-rules', { name: `rg-billing-${RUN}` }), 404)
    expect(await wallet()).toBe(before)
  })

  // OpenViCloud/titan-control-plane:Titan.Host/Program.cs (MapHealthChecks("/healthz/wallet"))
  test('BIL-13 /healthz/wallet is Healthy', async () => {
    const reply = await call('anonymous', 'GET', '/healthz/wallet')
    log(`BIL-13 ${reply.status} ${reply.text.slice(0, 200)}`)
    expectStatus(reply, 200)
  })

  // Read only, on the lane's tenant. The CronJob control-plane-invoice-generation ("0 2 1 * *", Etc/UTC) bills the previous UTC month
  // (OpenViCloud/titan-local-cluster:base/control-plane/invoice-generation-cronjob.yaml) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Billing/Invoice/GenerateInvoicesForPeriodCommandHandler.cs (HandleAsync: one item per
  // (ResourceType, ResourceId), named from the usage snapshot, amount UsageRecord.TotalVnd of its records) ·
  // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Invoice/Invoice.cs (Generate: DueAt = IssuedAt + PaymentTermDays (7), Total = Σ items) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Billing/UsageRecord/GetTenantBillingSummaryQueryHandler.cs (HandleAsync: perVm = raw Σ
  // of the VM's COMPUTE records; totalCost = COMPUTE + DISK + SNAPSHOT, the same records the invoice groups) ·
  // titan-ops features/billing/invoice/design.md#invoice-generation · titan-ops architecture/money-and-wallet.md#round-once
  test('BIL-17 the previous month invoice of the lane tenant: one invoice, due 7 days after issue, total = Σ items, one COMPUTE item per VM rounded once', async () => {
    const now = new Date()
    test.skip(now.getUTCDate() === 1 && now.getUTCHours() * 60 + now.getUTCMinutes() < 2 * 60 + 5,
      'before 02:05 UTC on the 1st: the monthly invoice run may not have finished')
    const period = previousUtcMonth(now)
    const summary = await get('tenant', `/v1/tenant/billing/summary?month=${period.query}`)
    log(`BIL-17 summary ${period.query}: totalCost=${summary.totalCost} perVm=${summary.perVm.length}`)
    test.skip(summary.perVm.length === 0 && summary.totalCost === 0, `the lane tenant had no usage in ${period.query}: no invoice to read`)

    const all = await get('tenant', '/v1/tenant/billing/invoices') as Invoice[]
    const ofPeriod = all.filter((i) => i.periodYear === period.year && i.periodMonth === period.month)
    expect(ofPeriod.length, `invoices of ${period.query}`).toBe(1)
    const invoice = await get('tenant', `/v1/tenant/billing/invoices/${ofPeriod[0].id}`) as Invoice & {
      items: Array<{ resourceType: string, resourceId: string, resourceName: string, amount: number, currency: string }>
    }
    log(`BIL-17 invoice ${invoice.id} ${invoiceShape(invoice)} total=${invoice.total} items=${invoice.items.length} issued=${invoice.issuedAt} due=${invoice.dueAt}`)
    expect(Date.parse(invoice.dueAt) - Date.parse(invoice.issuedAt)).toBe(7 * DAY_MS)
    expect(invoice.total).toBe(invoice.items.reduce((s, i) => s + i.amount, 0))
    expect(invoice.currency).toBe('VND')
    for (const vm of summary.perVm as Array<{ vmId: string, vmName: string, totalCost: number }>) {
      const lines = invoice.items.filter((i) => i.resourceId === vm.vmId)
      log(`BIL-17 vm ${vm.vmId} ${vm.vmName} raw=${vm.totalCost} lines=${JSON.stringify(lines)}`)
      expect(lines.length).toBe(1)
      expect(lines[0].resourceType).toBe('COMPUTE')
      expect(lines[0].resourceName).toBe(vm.vmName)
      expect(lines[0].amount).toBe(roundHalfAwayFromZero(vm.totalCost))
    }
    expect(Math.abs(invoice.total - summary.totalCost)).toBeLessThanOrEqual(0.5 * invoice.items.length)
  })

  // Metering, on the lane's tenant (no money moves). OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs
  // IsBilled — Running, Ready, Frozen, Error are billed; Stopped is not (titan-ops features/vm/design.md#counting-and-billing)
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
    // OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/UsageRecord/UsageRecord.cs (UsageRecord) — a running VM's line; one tick
    // costs the tier's hourly price × tick/60, not rounded (titan-ops architecture/money-and-wallet.md#round-once)
    expect(cost.breakdown.every((l: any) => l.usageType === 'RUNNING_VM')).toBe(true)
    const price = (await get('anonymous', '/v1/vm-offerings') as any[]).find((o) => o.id === smallTier).pricePerHour as number
    log(`BIL-01 first line ${JSON.stringify(cost.breakdown[0])}, price/h ${price}`)
    expect(cost.breakdown[0].cost).toBeCloseTo(price * (TICK_MS / 60_000) / 60, 6)

    // BIL-03: the summary's line for this VM is the VM's cost.
    const summary = await get('tenant', '/v1/tenant/billing/summary')
    const line = summary.perVm.find((l: any) => l.vmId === vmId)
    expect(line.totalCost).toBe(cost.totalCost)
    vmCostAtBil03 = cost.totalCost
    vmMonthAtBil03 = summary.month

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

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Billing/GetVmCostEndpoint.cs (HandleAsync: the VM is looked up and scoped to the
  // caller's tenant first ⇒ 404 VM_NOT_FOUND, then TryParseYearMonth ⇒ ThrowError(400)) ·
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Billing/GetTenantBillingSummaryEndpoint.cs (TryParseYearMonth: YYYY-MM, month 1..12) —
  // ThrowError's 400 carries VALIDATION_ERROR (OpenViCloud/titan-control-plane:Titan.Host/Program.cs, Errors.ResponseBuilder) ·
  // titan-ops features/billing/metering/design.md#usage-read
  test('BIL-03 a malformed month is 400 VALIDATION_ERROR on cost and summary; a VM of another tenant and an unknown VM are 404 VM_NOT_FOUND, before the month', async () => {
    expect(vmId, 'the VM of the metering case').not.toBe('')
    for (const month of ['2026-13', '2026-00', 'abc']) {
      expectError(await call('tenant', 'GET', `/v1/tenant/vms/${vmId}/cost?month=${month}`), 400, 'VALIDATION_ERROR')
      expectError(await call('tenant', 'GET', `/v1/tenant/billing/summary?month=${month}`), 400, 'VALIDATION_ERROR')
    }
    const unknown = randomUUID()
    expectError(await call('admin', 'GET', `/v1/tenant/vms/${vmId}/cost`), 404, 'VM_NOT_FOUND')
    expectError(await call('admin', 'GET', `/v1/tenant/vms/${vmId}/cost?month=abc`), 404, 'VM_NOT_FOUND')
    expectError(await call('tenant', 'GET', `/v1/tenant/vms/${unknown}/cost`), 404, 'VM_NOT_FOUND')
    expectError(await call('tenant', 'GET', `/v1/tenant/vms/${unknown}/cost?month=abc`), 404, 'VM_NOT_FOUND')
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Billing/UsageRecord/GetTenantBillingSummaryQueryHandler.cs (HandleAsync: perVm groups the
  // month's usage records, named from the record's snapshot, never the vms table) · titan-ops features/billing/metering/user-stories.md#us-b07 ·
  // titan-ops features/billing/metering/design.md#usage-read. Reads the month BIL-03 read, so a run across a month end still finds the VM.
  test('BIL-19 a deleted VM keeps its summary line, under the name it was created with, at no less than it cost before', async () => {
    expect(vmId, 'the VM of the metering case').not.toBe('')
    await deleteVmAndWait(vmId)
    const summary = await get('tenant', `/v1/tenant/billing/summary?month=${vmMonthAtBil03}`)
    const line = summary.perVm.find((l: any) => l.vmId === vmId)
    log(`BIL-19 ${vmMonthAtBil03} line of deleted ${vmId}: ${JSON.stringify(line)}; BIL-03 read ${vmCostAtBil03}`)
    expect(line).toBeDefined()
    expect(line.vmName).toBe(`rg-billvm-${RUN}`)
    expect(line.totalCost).toBeGreaterThanOrEqual(vmCostAtBil03)
  })
})
