import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import * as http from 'node:http'
import * as https from 'node:https'
import type { Socket } from 'node:net'
import { closeSessions, headersOf, useBrowser } from './auth'
import { API, call, expectError, expectStatus, log, sleep, startLog } from './api'
import { cleanUp } from './clean-up'
import { startLocalProxyIfNeeded } from './local-proxy'
import { fiveSessionsThenRefused, upgrade } from './ssh'
import { RUN, activityOf, countOf, createVm, deleteVmAndWait, envOf, runNetwork, runs, waitVm } from './fixtures'

// Cases SSH-08 and CSL-06 of plan.md on the release environment: a job of its own (run-module.sh … vm/ssh-sessions …), since the
// vm module runs on dev only and SSH sessions there never cross the edge in front of the release environment's API.
// The bodies are lib/ssh.ts fiveSessionsThenRefused and consoleRefusedAtTheLimit below, which vm/vm.spec.ts runs on dev.
// They count beta-user's SSH and console sessions, so no other job that opens one (cli, cli/edge) runs beside it
// (titan-ops architecture/testing.md#regression-dev-before-candidate).
//
// The helpers below are a copy of vm/vm.spec.ts's (Ws, openWs, newTicket, issueTicket, openConsole,
// consoleRefusedAtTheLimit): the runner loads one directory flat, and lib/ holds no websocket framing.

// --- websocket frames ----------------------------------------------------------------------------------------

// A websocket over a raw HTTP/1.1 upgrade, framed by hand (RFC 6455): lib/ssh.ts upgrade() hands back the socket only,
// and the cases below read the server's frames (the SSH banner, console bytes, a close code and its reason). Binary
// frames are the session's bytes; a text frame from the server is counted, not kept.
class Ws {
  status: number
  code: string
  contentLength: string | undefined
  socket: Socket | null
  closeCode: number | null = null
  closeReason = ''
  gone = false
  textFrames = 0
  pending: Buffer = Buffer.alloc(0)
  dataOpcode = 0
  chunks: Buffer[] = []
  size = 0
  closeSent = false

  constructor(status: number, code: string, contentLength: string | undefined, socket: Socket | null, head: Buffer) {
    this.status = status
    this.code = code
    this.contentLength = contentLength
    this.socket = socket
    if (socket !== null) {
      socket.on('data', (chunk: Buffer) => this.take(chunk))
      socket.on('close', () => { this.gone = true })
      socket.on('error', () => {})
      if (head.length > 0) {
        this.take(head)
      }
    }
  }

  take(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 2) {
      const first = this.pending[0]
      const second = this.pending[1]
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.pending.length < 4) {
          return
        }
        length = this.pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.pending.length < 10) {
          return
        }
        length = Number(this.pending.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const maskAt = offset
      if (masked) {
        offset += 4
      }
      if (this.pending.length < offset + length) {
        return
      }
      const payload = Buffer.from(this.pending.subarray(offset, offset + length))
      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= this.pending[maskAt + (i % 4)]
        }
      }
      this.pending = this.pending.subarray(offset + length)
      this.frame(first & 0x0f, payload)
    }
  }

  frame(opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      this.closeReason = payload.subarray(2).toString('utf8')
      this.send(0x8, payload.subarray(0, payload.length >= 2 ? 2 : 0))
      this.socket?.end()
      return
    }
    if (opcode === 0x9) {
      this.send(0xa, payload)
      return
    }
    if (opcode === 0xa) {
      return
    }
    if (opcode !== 0x0) {
      this.dataOpcode = opcode
    }
    if (this.dataOpcode === 0x2) {
      this.chunks.push(payload)
      this.size += payload.length
    } else {
      this.textFrames++
    }
  }

  // A client frame is masked (RFC 6455 §5.3).
  send(opcode: number, payload: Buffer): void {
    if (this.socket === null || this.socket.destroyed || this.closeSent) {
      return
    }
    if (opcode === 0x8) {
      this.closeSent = true
    }
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    const mask = randomBytes(4)
    const body = Buffer.alloc(payload.length)
    for (let i = 0; i < payload.length; i++) {
      body[i] = payload[i] ^ mask[i % 4]
    }
    this.socket.write(Buffer.concat([header, mask, body]))
  }

  sendText(text: string): void {
    this.send(0x1, Buffer.from(text, 'utf8'))
  }

  sendBinary(text: string): void {
    this.send(0x2, Buffer.from(text, 'utf8'))
  }

  close(code: number): void {
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    this.send(0x8, payload)
  }

  // Bytes received so far: a mark for textSince.
  bytes(): number {
    return this.size
  }

  textSince(mark: number): string {
    return Buffer.concat(this.chunks).subarray(mark).toString('utf8')
  }

  isClosed(): boolean {
    return this.closeCode !== null || this.gone
  }

  async until(done: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (!done()) {
      if (Date.now() >= deadline) {
        return false
      }
      await sleep(200)
    }
    return true
  }

  // Ends the session from this side: a close frame, the server's answer for up to 10 s, then the socket.
  async end(): Promise<void> {
    if (this.socket === null) {
      return
    }
    this.close(1000)
    await this.until(() => this.isClosed(), 10_000)
    this.destroy()
  }

  destroy(): void {
    this.socket?.destroy()
    this.gone = true
  }
}

// An upgrade as the CLI (SSH, with the token) or the portal (console, no token: the ticket authenticates it) sends it.
async function openWs(path: string, withToken: boolean): Promise<Ws> {
  await startLocalProxyIfNeeded(API)
  const auth: Record<string, string> = withToken ? await headersOf('tenant') : {}
  const url = new URL(`${API}${path}`)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: 'GET',
      headers: {
        ...auth,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    })
    request.on('upgrade', (res, socket, head) => {
      socket.setTimeout(0)
      socket.removeAllListeners('timeout')
      resolve(new Ws(res.statusCode ?? 0, '', undefined, socket as Socket, head))
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
        resolve(new Ws(res.statusCode ?? 0, code, res.headers['content-length'], null, Buffer.alloc(0)))
      })
    })
    request.on('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('upgrade timed out')))
    request.end()
  })
}

// --- console -------------------------------------------------------------------------------------------------

// The shape the portal makes: ovct_ + 43 base64url characters of 32 random bytes
// (OpenViCloud/titan-cloud-console:portal/src/lib/consoleSession.ts newConsoleTicket).
function newTicket(): string {
  return `ovct_${randomBytes(32).toString('base64url')}`
}

async function issueTicket(vmId: string): Promise<string> {
  const ticket = newTicket()
  expectStatus(await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/console-tickets`, { ticket }), 204)
  return ticket
}

function openConsole(vmId: string, ticket: string | null): Promise<Ws> {
  const query = ticket === null ? '' : `?ticket=${ticket}`
  return openWs(`/v1/tenant/vms/${vmId}/console${query}`, false)
}

// CSL-06 of plan.md, run by vm/vm.spec.ts (dev) and, the same body, by vm/ssh-sessions/ssh-sessions.spec.ts (the release
// environment). lib/ssh.ts fiveSessionsThenRefused opens its five sessions with no place to issue a ticket between them,
// so this opens five of its own on the same running VM right after SSH-08 · titan-ops features/vm/design.md#vm-console ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/CreateVmConsoleTicketEndpoint.cs (HandleAsync:
// limiter.HasRoomAsync, takes no place) · OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Vm/OpenVmConsoleEndpoint.cs
// (RunAsync: limiter.TryAcquireAsync before Incus and before RequestVmConsoleCommand; CloseAsync 4000 + 422) ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ConsoleTicketStore.cs (Lifetime, 30 s) ·
// OpenViCloud/titan-control-plane:Titan.Infrastructure/Sessions/ShellSessionLimiter.cs (MaxSessionsPerTenant, 5)
async function consoleRefusedAtTheLimit(vmId: string, vmName: string): Promise<void> {
  const ssh = `/v1/tenant/vms/${vmId}/ssh`
  // SSH-08's last session gives its place back once closed; it waits as long before opening again.
  await sleep(15_000)
  const before = countOf(await activityOf(vmName), 'vm.console_requested')
  const held: Socket[] = []
  let consoleWs: Ws | null = null
  try {
    for (let i = 1; i <= 4; i++) {
      const reply = await upgrade(ssh)
      log(`CSL-06 SSH session ${i} → ${reply.status} ${reply.code}`)
      if (reply.socket !== null) {
        held.push(reply.socket)
      }
      expect(reply.status, `SSH session ${i}`).toBe(101)
    }
    const ticket = await issueTicket(vmId)
    const issuedAt = Date.now()
    const fifth = await upgrade(ssh)
    log(`CSL-06 SSH session 5 → ${fifth.status} ${fifth.code}`)
    if (fifth.socket !== null) {
      held.push(fifth.socket)
    }
    expect(fifth.status, 'SSH session 5').toBe(101)

    const refused = await call('tenant', 'POST', `/v1/tenant/vms/${vmId}/console-tickets`, { ticket: newTicket() })
    log(`CSL-06 ticket at five sessions → ${refused.status} ${refused.text.slice(0, 200)}`)
    expectError(refused, 422, 'VM_SESSION_LIMIT_REACHED')

    const sinceIssued = Date.now() - issuedAt
    log(`CSL-06 console upgrade ${Math.round(sinceIssued / 1000)} s after its ticket`)
    expect(sinceIssued, 'the console opens within the ticket\'s 30 s').toBeLessThan(30_000)
    consoleWs = await openConsole(vmId, ticket)
    const opened = consoleWs
    expect(opened.status, `console upgrade ${opened.code}`).toBe(101)
    await opened.until(() => opened.isClosed(), 45_000)
    log(`CSL-06 console closed ${opened.closeCode} ${opened.closeReason}`)
    expect(opened.closeCode).toBe(4422)
    expect(opened.closeReason).toBe('VM_SESSION_LIMIT_REACHED')
  } finally {
    consoleWs?.destroy()
    for (const socket of held) {
      socket.destroy()
    }
  }
  expect(countOf(await activityOf(vmName), 'vm.console_requested')).toBe(before)
}

const VM_NAME = `rg-vmssh-${RUN}`
let vmId = ''

test.beforeAll(async ({ browser }) => {
  startLog('ssh-sessions')
  useBrowser(browser)
})

test.afterAll(async () => {
  test.setTimeout(10 * 60_000)
  const steps: Array<[string, () => Promise<void>]> = []
  if (vmId !== '') {
    steps.push([`delete VM ${vmId}`, () => deleteVmAndWait(vmId)])
  }
  steps.push(['sessions', closeSessions])
  await cleanUp(steps)
})

test('SSH-08 five SSH sessions open (101), the sixth is 422 VM_SESSION_LIMIT_REACHED; one opens again after they close', async () => {
  test.setTimeout(25 * 60_000)
  const { smallTier } = await envOf()
  vmId = await createVm(VM_NAME, smallTier, (await runNetwork()).id)
  await waitVm(`SSH-08 ${VM_NAME}`, vmId, (v) => runs(v))
  await fiveSessionsThenRefused(vmId, VM_NAME)
})

// The body is consoleRefusedAtTheLimit above, on SSH-08's VM right after it (its guest answers SSH already).
test('CSL-06 at five SSH sessions a console ticket is 422 VM_SESSION_LIMIT_REACHED, and a ticket issued before the fifth opens a console that closes 4422 VM_SESSION_LIMIT_REACHED', async () => {
  test.setTimeout(10 * 60_000)
  test.skip(vmId === '', 'SSH-08 made no VM')
  await waitVm(`CSL-06 ${VM_NAME}`, vmId, (v) => runs(v))
  await consoleRefusedAtTheLimit(vmId, VM_NAME)
})
