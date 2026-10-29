import { randomBytes } from 'node:crypto'
import { API, type Reply } from './api'
import { fetchOnceMoreOnEdgeFailure } from './edge-retry'
import { startLocalProxyIfNeeded } from './local-proxy'

// API tokens the specs create: the secret is made here as the portal makes it, ovc_ + 32 random bytes in
// base64url (titan-ops features/public-api/design.md#api-token), and is never logged.
export function newSecret(): string {
  return 'ovc_' + randomBytes(32).toString('base64url')
}

// One call authenticated by an API token instead of the signed-in JWT; `scheme` lets a case send `bearer`.
export async function callWithToken(secret: string, method: string, path: string, data?: unknown,
  idempotencyKey?: string, scheme: string = 'Bearer'): Promise<Reply> {
  await startLocalProxyIfNeeded(API)
  const headers: Record<string, string> = { Authorization: `${scheme} ${secret}` }
  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey
  }
  let body: string | undefined = undefined
  if (data !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(data)
  }
  const res = await fetchOnceMoreOnEdgeFailure(`${API}${path}`, { method, headers, body })
  return { status: res.status, text: await res.text(), url: `${method} ${path} (API token)` }
}
