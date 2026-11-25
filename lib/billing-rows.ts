// The Billing page's usage table against the API's perVm, as a multiset of (VM name, amount shown). A VM's name is not
// a row's identity: a name is free again once its VM is deleted, so one month can hold two VMs of one name, and the
// page shows only the name and the amount (OpenViCloud/titan-cloud-console:portal/src/pages/BillingPage.tsx; the VM
// id is a React key, not in the DOM). So each name must have as many rows as the API has lines of it, with the same
// amounts; two VMs of one name and one amount cannot be told apart, and need not be.
// No imports: selftest runs this file without Playwright.
export type BillingRow = { name: string, amount: string }

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim()

// Each row the API has and the page lacks as `missing <name> <amount>`, each row the page has and the API lacks as
// `extra <name> <amount>`, sorted; empty when the two agree.
export function billingRowsDiff(expected: BillingRow[], shown: BillingRow[]): string[] {
  const key = (row: BillingRow) => `${norm(row.name)} ${norm(row.amount)}`
  const left = new Map<string, number>()
  for (const row of expected) {
    left.set(key(row), (left.get(key(row)) ?? 0) + 1)
  }
  const extra: string[] = []
  for (const row of shown) {
    const n = left.get(key(row)) ?? 0
    if (n > 0) {
      left.set(key(row), n - 1)
    } else {
      extra.push(`extra ${key(row)}`)
    }
  }
  const missing: string[] = []
  for (const [k, n] of left) {
    for (let i = 0; i < n; i++) {
      missing.push(`missing ${k}`)
    }
  }
  return [...missing, ...extra].sort()
}
