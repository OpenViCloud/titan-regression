import * as net from 'node:net'

// The host reaches the local cluster on *.localhost:8080 (host port 8080 → Traefik :80), and Keycloak's issuer
// carries that port, so the browser in the runner pod must use the same URLs. Chromium maps *.localhost to
// loopback; this proxy carries loopback:8080 to Traefik's service (OpenViCloud/titan-ops:docs/infra/environments/local-cluster/topology.md#runbook).
const TRAEFIK_HOST = 'traefik.kube-system.svc.cluster.local'
const TRAEFIK_PORT = 80

let started: Promise<void> | null = null

function listen(): Promise<void> {
  const server = net.createServer((client) => {
    const upstream = net.connect(TRAEFIK_PORT, TRAEFIK_HOST)
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  return new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      // A second spec file in the same job finds the first one's proxy already listening.
      if (err.code === 'EADDRINUSE') {
        resolve()
        return
      }
      reject(err)
    })
    server.listen(8080, '127.0.0.1', () => {
      server.unref()
      resolve()
    })
  })
}

// Only the local cluster needs it: every other environment's URLs are real hosts.
export function startLocalProxyIfNeeded(portalUrl: string): Promise<void> {
  const isLocal = new URL(portalUrl).hostname.endsWith('.localhost')
  if (!isLocal) {
    return Promise.resolve()
  }
  if (started === null) {
    started = listen()
  }
  return started
}
