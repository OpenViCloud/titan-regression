// Names Titan gives on Incus, and the run's Phase 4 keys: no import, so selftest/ runs it without Playwright.

// OpenViCloud/titan-incus-worker:incus/provider/names.go (objectName) — prefix + the 16 bytes of the id in lowercase base32
export function incusName(prefix: string, id: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = Buffer.from(id.replace(/-/g, ''), 'hex')
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31]
  }
  return prefix + out
}

// OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Tenant/Tenant.cs ProjectNameFor
export function projectOf(tenantId: string): string {
  return `t-${tenantId.replace(/-/g, '')}`
}

// The public half of the run's key pair V or U: run-module.sh passes REGRESSION_PHASE4_KEYS/<v|u>.pub as
// PHASE4_KEY_V/PHASE4_KEY_U. No default: a key written into the spec outlives the private half it belongs to.
export function phase4Key(name: 'V' | 'U', env: Record<string, string | undefined> = process.env): string {
  const key = (env[`PHASE4_KEY_${name}`] ?? '').trim()
  if (!/^ssh-[a-z0-9-]+ AAAA\S+( \S+)?$/.test(key)) {
    throw new Error(`PHASE4_KEY_${name} is not one public key line: run run-module.sh with REGRESSION_PHASE4_KEYS=<dir> (python3 phase4.py keys <dir>)`)
  }
  return key
}
