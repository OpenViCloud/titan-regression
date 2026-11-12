// Run: node --test 'selftest/*.test.ts' (Node 22.23.3 strips the types itself; nothing to install)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meterTickMs } from '../lib/meter.ts'

test('unset or empty is the control plane default of 10 minutes', () => {
  assert.equal(meterTickMs(undefined), 10 * 60_000)
  assert.equal(meterTickMs(''), 10 * 60_000)
  assert.equal(meterTickMs('  '), 10 * 60_000)
})

test('a whole number of minutes is that many minutes', () => {
  assert.equal(meterTickMs('1'), 60_000)
  assert.equal(meterTickMs(' 2 '), 2 * 60_000)
  assert.equal(meterTickMs('10'), 10 * 60_000)
})

test('anything else throws instead of guessing a tick', () => {
  for (const bad of ['0', '-1', '1.5', 'two', '1m', '01']) {
    assert.throws(() => meterTickMs(bad), /not a whole number of minutes/, bad)
  }
})
