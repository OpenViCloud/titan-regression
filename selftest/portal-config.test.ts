// Run: node --test 'selftest/*.test.ts' (Node 22.23.3 strips the types itself; nothing to install)
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { topUpEnabledOf } from '../lib/portal-config.ts'

// The helper keeps one config per portal for the whole process, so every test uses a portal of its own.
let urls: string[] = []
let answers: Array<Response | Error> = []
const realFetch = globalThis.fetch

beforeEach(() => {
  urls = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url))
    const answer = answers.shift()
    if (answer instanceof Error) {
      throw answer
    }
    if (answer === undefined) {
      throw new Error('no answer queued')
    }
    return answer
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  answers = []
})

function config(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('topUpEnabled true turns top-up on, read from <portal>/config.json', async () => {
  answers = [config({ apiBaseUrl: 'x', topUpEnabled: true })]
  assert.equal(await topUpEnabledOf('https://portal.one.test'), true)
  assert.deepEqual(urls, ['https://portal.one.test/config.json'])
})

test('a missing, false or string topUpEnabled leaves top-up off', async () => {
  answers = [config({ apiBaseUrl: 'x' }), config({ topUpEnabled: false }), config({ topUpEnabled: 'true' })]
  assert.equal(await topUpEnabledOf('https://portal.missing.test'), false)
  assert.equal(await topUpEnabledOf('https://portal.false.test'), false)
  assert.equal(await topUpEnabledOf('https://portal.string.test'), false)
})

test('the config is read once per portal', async () => {
  answers = [config({ topUpEnabled: true })]
  assert.equal(await topUpEnabledOf('https://portal.once.test'), true)
  assert.equal(await topUpEnabledOf('https://portal.once.test'), true)
  assert.equal(urls.length, 1)
})

test('a config that cannot be read throws instead of reading as off, and is read again next time', async () => {
  answers = [config({ title: 'Bad Gateway' }, 502), new Response('<html>edge</html>', { status: 200 }),
    config(['not', 'an', 'object']), config({ topUpEnabled: true })]
  await assert.rejects(topUpEnabledOf('https://portal.broken.test'), /config\.json answered 502/)
  await assert.rejects(topUpEnabledOf('https://portal.broken.test'), SyntaxError)
  await assert.rejects(topUpEnabledOf('https://portal.broken.test'), /not a JSON object/)
  assert.equal(await topUpEnabledOf('https://portal.broken.test'), true)
  assert.equal(urls.length, 4)
})
