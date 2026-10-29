import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { forceSignIn, headersOf } from './auth'
import { fetchOnceMoreOnEdgeFailure } from './edge-retry'
import { startLocalProxyIfNeeded } from './local-proxy'

export const API = process.env.API_BASE_URL || 'http://api.localhost:8080'
export const RESULTS = process.env.RESULTS_DIR || 'results'

// --- log: one file per module, so the evidence shows the path and not only the end --------------------------

let logFile = 'run.txt'
const lines: string[] = []

export function startLog(module: string): void {
  logFile = `${module}.txt`
}

export function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`
  lines.push(stamped)
  console.log(stamped)
  fs.mkdirSync(RESULTS, { recursive: true })
  fs.writeFileSync(`${RESULTS}/${logFile}`, lines.join('\n') + '\n')
}

// --- calls ---------------------------------------------------------------------------------------------------

export type As = 'tenant' | 'admin' | 'anonymous'

export type Reply = {
  status: number
  text: string
  url: string
}

export function newKey(): string {
  return randomUUID()
}

async function send(as: As, method: string, path: string, data: unknown, idempotencyKey: string | undefined): Promise<Reply> {
  await startLocalProxyIfNeeded(API)
  const headers: Record<string, string> = {}
  if (as !== 'anonymous') {
    Object.assign(headers, await headersOf(as))
  }
  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey
  }
  let body: string | undefined = undefined
  if (data !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(data)
  }
  const res = await fetchOnceMoreOnEdgeFailure(`${API}${path}`, { method, headers, body })
  return { status: res.status, text: await res.text(), url: `${method} ${path}` }
}

export async function call(as: As, method: string, path: string, data?: unknown, idempotencyKey?: string): Promise<Reply> {
  let reply = await send(as, method, path, data, idempotencyKey)
  if (reply.status === 401 && as !== 'anonymous') {
    await forceSignIn(as)
    reply = await send(as, method, path, data, idempotencyKey)
  }
  return reply
}

export function expectStatus(reply: Reply, status: number): void {
  expect(reply.status, `${reply.url} → ${reply.text.slice(0, 300)}`).toBe(status)
}

export function bodyOf(reply: Reply): any {
  if (reply.text.trim() === '') {
    return {}
  }
  return JSON.parse(reply.text)
}

// The error envelope is { status, title, code }: the code is in `code`, not `detail`
// (titan-ops architecture/http-contract.md#error-envelope).
export function expectError(reply: Reply, status: number, code: string): void {
  expectStatus(reply, status)
  expect(bodyOf(reply).code, `${reply.url} → ${reply.text.slice(0, 300)}`).toBe(code)
}

export async function get(as: As, path: string): Promise<any> {
  const reply = await call(as, 'GET', path)
  expectStatus(reply, 200)
  return bodyOf(reply)
}

// --- waiting -------------------------------------------------------------------------------------------------

// Long enough for two reconciler cycles (2 minutes each, titan-ops architecture/provider-and-worker.md#reconciler-is-a-worker-ticker)
// plus the provider work itself.
export const OBSERVED_WITHIN_MS = 6 * 60_000

export async function pollUntil<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean,
  shape: (value: T) => string, timeoutMs: number = OBSERVED_WITHIN_MS, everyMs: number = 5_000): Promise<T> {
  const started = Date.now()
  let lastShape = ''
  while (true) {
    const value = await read()
    const current = shape(value)
    if (current !== lastShape) {
      log(`${label} … ${current} (+${Math.round((Date.now() - started) / 1000)}s)`)
      lastShape = current
    }
    if (done(value)) {
      return value
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s at ${current}`)
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
