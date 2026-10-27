// Run: node --test 'selftest/*.test.ts' (Node 22.23.3 strips the types itself; nothing to install)
// Outside lib on purpose: the runner copies lib/ into e2e/, and Playwright's default testMatch runs *.test.ts.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchOnceMoreOnEdgeFailure, isConnectTimeout } from '../lib/edge-retry.ts'

function failedFetch(cause: object): TypeError {
  return new TypeError('fetch failed', { cause })
}

const connectTimeout = failedFetch({ name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })
const reset = failedFetch({ code: 'ECONNRESET' })

function edgePage(status: number): Response {
  return new Response('<!doctype html><html><body>edge</body></html>', {
    status, headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  })
}

function apiError(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, title: 'x', code }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

let calls = 0
let answers: Array<Response | Error> = []
const realFetch = globalThis.fetch

beforeEach(() => {
  calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    const answer = answers.shift()
    if (answer instanceof Error) {
      throw answer
    }
    if (answer !== undefined) {
      return answer
    }
    return new Response('ok', { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  answers = []
})

test('a connect timeout is sent once more and the second answer is returned', async () => {
  answers = [connectTimeout]
  const res = await fetchOnceMoreOnEdgeFailure('http://api.test/v1/clusters', { method: 'POST' })
  assert.equal(res.status, 200)
  assert.equal(calls, 2)
})

test('a second connect timeout is not retried again', async () => {
  answers = [connectTimeout, connectTimeout]
  await assert.rejects(fetchOnceMoreOnEdgeFailure('http://api.test/v1/clusters', { method: 'GET' }), (error) => error === connectTimeout)
  assert.equal(calls, 2)
})

test('a reset may have reached the server, so a write is not retried', async () => {
  answers = [reset]
  await assert.rejects(fetchOnceMoreOnEdgeFailure('http://api.test/v1/vms', { method: 'POST' }), (error) => error === reset)
  assert.equal(calls, 1)
})

test('a read that hit a reset is sent once more', async () => {
  answers = [reset]
  const res = await fetchOnceMoreOnEdgeFailure('http://api.test/v1/tenant/vms/1', { method: 'GET' })
  assert.equal(res.status, 200)
  assert.equal(calls, 2)
})

test('a read whose second try also fails gives up with that failure', async () => {
  answers = [reset, reset]
  await assert.rejects(fetchOnceMoreOnEdgeFailure('http://api.test/v1/tenant/vms/1', {}), (error) => error === reset)
  assert.equal(calls, 2)
})

test('a read answered by an edge page is sent once more', async () => {
  answers = [edgePage(409)]
  const res = await fetchOnceMoreOnEdgeFailure('http://api.test/v1/tenant/load-balancers/1', { method: 'GET' })
  assert.equal(res.status, 200)
  assert.equal(calls, 2)
})

test('an error of the API is the answer, not something to retry', async () => {
  answers = [apiError(409, 'REQUEST_IN_PROGRESS')]
  const res = await fetchOnceMoreOnEdgeFailure('http://api.test/v1/tenant/vms/1', { method: 'GET' })
  assert.equal(res.status, 409)
  assert.equal(calls, 1)
})

test('a write answered by an edge page is not sent again', async () => {
  answers = [edgePage(502)]
  const res = await fetchOnceMoreOnEdgeFailure('http://api.test/v1/tenant/vms', { method: 'DELETE' })
  assert.equal(res.status, 502)
  assert.equal(calls, 1)
})

test('only the undici connect-timeout shapes count', () => {
  assert.equal(isConnectTimeout(connectTimeout), true)
  assert.equal(isConnectTimeout(failedFetch({ name: 'ConnectTimeoutError' })), true)
  assert.equal(isConnectTimeout(failedFetch({ code: 'UND_ERR_CONNECT_TIMEOUT' })), true)
  assert.equal(isConnectTimeout(reset), false)
  assert.equal(isConnectTimeout(new TypeError('fetch failed')), false)
  assert.equal(isConnectTimeout(null), false)
  assert.equal(isConnectTimeout('timeout'), false)
})
