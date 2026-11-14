import { expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import type { Socket } from 'node:net'
import { headersOf } from './auth'
import { API, log, sleep } from './api'
import { startLocalProxyIfNeeded } from './local-proxy'
import { activityOf, countOf } from './fixtures'

// How long a running VM's guest gets to start its agent and sshd before an SSH session can open. Measured on dev
// (arm64, 2026-11-13): on an idle cluster a Titan-like VM had its sshd banner 261 s after start and key login about
// 30 s later; during a regression run the agent took from 3 to more than 5 minutes. Only a red run waits it out: a
// wait loop fails at once on any answer other than a guest still starting (titan-ops features/vm/design.md#ssh-session).
export const GUEST_START_WAIT_MS = 10 * 60_000

// A websocket upgrade over HTTP/1.1, as the CLI sends it (fetch cannot send Upgrade). An accepted one (101) hands back
// its socket, kept open until the caller destroys it; a refused one answers the usual JSON error.
export type Upgrade = { status: number, code: string, socket: Socket | null, firstByte: Promise<void> }

export async function upgrade(path: string): Promise<Upgrade> {
  await startLocalProxyIfNeeded(API)
  const headers = await headersOf('tenant')
  const url = new URL(`${API}${path}`)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'GET',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    request.on('upgrade', (res, socket, head) => {
      // The request's 30 s timeout must not end a session held open on purpose.
      socket.setTimeout(0)
      socket.removeAllListeners('timeout')
      let gotByte = (): void => {}
      const firstByte = new Promise<void>((done) => { gotByte = done })
      if (head.length > 0) {
        gotByte()
      }
      socket.on('data', () => gotByte())
      socket.on('error', () => {})
      resolve({ status: res.statusCode ?? 0, code: '', socket: socket as Socket, firstByte })
    })
    request.on('response', (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let code = ''
        try {
          code = JSON.parse(text).code ?? ''
        } catch {
          code = `(not JSON: ${text.slice(0, 120)})`
        }
        resolve({ status: res.statusCode ?? 0, code, socket: null, firstByte: new Promise<void>(() => {}) })
      })
    })
    request.on('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('upgrade timed out')))
    request.end()
  })
}

// SSH-08 of plan.md, run by vm/vm.spec.ts (dev) and vm/ssh-sessions/ssh-sessions.spec.ts (prd) on a running VM of
// beta-user while no other SSH session of that tenant is open · titan-ops features/vm/design.md#ssh-session ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmSshEndpoint.cs HandleAsync
// (limiter.TryAcquireAsync before request.HandleAsync: a refusal records no vm.ssh_requested) ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ShellSessionLimiter.cs MaxSessionsPerTenant (5, one row
// each in core.shell_sessions, so every control plane replica counts the same) · the guest's sshd ends an
// unauthenticated session after its LoginGraceTime (120 s by default), so the sixth is opened while the five are surely
// still held.
export async function fiveSessionsThenRefused(vmId: string, vmName: string): Promise<void> {
  const path = `/v1/tenant/vms/${vmId}/ssh`
  // The guest may still be starting (422 VM_AGENT_NOT_READY, then 422 VM_SSH_NOT_READY until its sshd listens). Right
  // after sshd first listens it can still hold its banner past the control plane's 5 s wait and drop connections
  // (measured on dev 2026-11-14 on a VM just made: two of six sessions ended with no byte, which freed a place and let
  // the sixth open). So counting starts only after three probes in a row got the banner within 2 s of their 101.
  const started = Date.now()
  let quickInARow = 0
  while (quickInARow < 3) {
    const probe = await upgrade(path)
    if (probe.status === 101) {
      const quick = await Promise.race([probe.firstByte.then(() => true), sleep(2_000).then(() => false)])
      probe.socket!.destroy()
      log(`SSH-08 probe → 101, banner ${quick ? 'within 2 s' : 'not within 2 s'}`)
      quickInARow = quick ? quickInARow + 1 : 0
    } else {
      log(`SSH-08 probe → ${probe.status} ${probe.code}`)
      expect(['VM_AGENT_NOT_READY', 'VM_SSH_NOT_READY'], `probe ${probe.status} ${probe.code}`).toContain(probe.code)
      quickInARow = 0
    }
    expect(Date.now() - started, 'the guest agent and sshd answer within GUEST_START_WAIT_MS').toBeLessThan(GUEST_START_WAIT_MS)
    if (quickInARow < 3) {
      await sleep(10_000)
    }
  }
  await sleep(15_000)

  const before = countOf(await activityOf(vmName), 'vm.ssh_requested')
  const held: Socket[] = []
  try {
    const firstOpened = Date.now()
    for (let i = 1; i <= 5; i++) {
      const reply = await upgrade(path)
      log(`SSH-08 session ${i} → ${reply.status} ${reply.code}`)
      if (reply.socket !== null) {
        held.push(reply.socket)
      }
      expect(reply.status, `session ${i}`).toBe(101)
    }
    const sixth = await upgrade(path)
    log(`SSH-08 session 6 → ${sixth.status} ${sixth.code} (+${Math.round((Date.now() - firstOpened) / 1000)}s)`)
    if (sixth.socket !== null) {
      held.push(sixth.socket)
    }
    expect(Date.now() - firstOpened, 'the sixth is opened within 2 minutes of the first').toBeLessThan(2 * 60_000)
    // Not part of the expectation; tells a 101 sixth caused by a session the server already ended from a limiter fault.
    log(`SSH-08 sessions still open on the client side: ${held.filter((s) => !s.destroyed).length}`)
    expect(sixth.status).toBe(422)
    expect(sixth.code).toBe('VM_SESSION_LIMIT_REACHED')
    expect(countOf(await activityOf(vmName), 'vm.ssh_requested') - before).toBe(5)
  } finally {
    for (const socket of held) {
      socket.destroy()
    }
  }
  await sleep(15_000)
  const again = await upgrade(path)
  log(`SSH-08 after closing → ${again.status} ${again.code}`)
  again.socket?.destroy()
  expect(again.status).toBe(101)
}
