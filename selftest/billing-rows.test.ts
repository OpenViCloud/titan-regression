// Run: node --test 'selftest/*.test.ts' (Node 22.23.3 strips the types itself; nothing to install)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billingRowsDiff } from '../lib/billing-rows.ts'

test('the same rows in another order agree', () => {
  assert.deepEqual(billingRowsDiff(
    [{ name: 'rg-a', amount: '1,643 ₫' }, { name: 'rg-b', amount: '340 ₫' }],
    [{ name: 'rg-b', amount: '340 ₫' }, { name: 'rg-a', amount: '1,643 ₫' }]), [])
})

test('two VMs of one name: both rows are needed, each with its own amount', () => {
  const api = [{ name: 'rg-drill-a', amount: '1,643 ₫' }, { name: 'rg-drill-a', amount: '340 ₫' }]
  assert.deepEqual(billingRowsDiff(api, [{ name: 'rg-drill-a', amount: '340 ₫' }, { name: 'rg-drill-a', amount: '1,643 ₫' }]), [])
  assert.deepEqual(billingRowsDiff(api, [{ name: 'rg-drill-a', amount: '1,643 ₫' }]), ['missing rg-drill-a 340 ₫'])
  assert.deepEqual(billingRowsDiff(api, [{ name: 'rg-drill-a', amount: '1,643 ₫' }, { name: 'rg-drill-a', amount: '1,643 ₫' }]),
    ['extra rg-drill-a 1,643 ₫', 'missing rg-drill-a 340 ₫'])
})

test('two VMs of one name and one amount count twice', () => {
  const api = [{ name: 'rg-a', amount: '5 ₫' }, { name: 'rg-a', amount: '5 ₫' }]
  assert.deepEqual(billingRowsDiff(api, [{ name: 'rg-a', amount: '5 ₫' }, { name: 'rg-a', amount: '5 ₫' }]), [])
  assert.deepEqual(billingRowsDiff(api, [{ name: 'rg-a', amount: '5 ₫' }]), ['missing rg-a 5 ₫'])
})

test('a name is matched whole, not as a part of a longer one', () => {
  assert.deepEqual(billingRowsDiff([{ name: 'rg-a', amount: '5 ₫' }], [{ name: 'rg-ab', amount: '5 ₫' }]),
    ['extra rg-ab 5 ₫', 'missing rg-a 5 ₫'])
})

test('the amount is the whole cell: 1,643 ₫ is not 643 ₫', () => {
  assert.deepEqual(billingRowsDiff([{ name: 'rg-a', amount: '643 ₫' }], [{ name: 'rg-a', amount: '1,643 ₫' }]),
    ['extra rg-a 1,643 ₫', 'missing rg-a 643 ₫'])
})

test('white space the page puts around or inside a cell does not count', () => {
  assert.deepEqual(billingRowsDiff([{ name: 'rg-a', amount: '1.643 ₫' }], [{ name: ' rg-a\n', amount: '1.643 ₫ ' }]), [])
})

test('no rows on either side agree; a row on one side only does not', () => {
  assert.deepEqual(billingRowsDiff([], []), [])
  assert.deepEqual(billingRowsDiff([], [{ name: 'rg-a', amount: '5 ₫' }]), ['extra rg-a 5 ₫'])
})
