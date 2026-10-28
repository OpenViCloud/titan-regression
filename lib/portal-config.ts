// The customer portal's runtime config, <portal>/config.json: the portal reads it at start and gates screens on it
// (OpenViCloud/titan-cloud-console:portal/src/lib/config.ts AppConfig). Read once per portal and process.
// A config that cannot be read throws: the case goes red, never N/A on a broken portal.
// On the local cluster the caller starts the local proxy first (pageOf does).
// No imports: selftest runs this file without Playwright.
const configs = new Map<string, Promise<Record<string, unknown>>>()

async function read(portal: string): Promise<Record<string, unknown>> {
  const url = `${portal}/config.json`
  const res = await fetch(url)
  if (res.status !== 200) {
    throw new Error(`${url} answered ${res.status}`)
  }
  const body = await res.json()
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`${url} is not a JSON object`)
  }
  return body as Record<string, unknown>
}

export function portalConfigOf(portal: string): Promise<Record<string, unknown>> {
  let config = configs.get(portal)
  if (config === undefined) {
    config = read(portal)
    configs.set(portal, config)
    // A failed read is not kept: the next case reads again rather than repeating the first failure.
    config.catch(() => configs.delete(portal))
  }
  return config
}

// The portal shows Buy credit, Receipts and the buy-credit dialog only for exactly true
// (OpenViCloud/titan-cloud-console:portal/src/pages/WalletPage.tsx WalletPage: getConfig().topUpEnabled === true).
export async function topUpEnabledOf(portal: string): Promise<boolean> {
  return (await portalConfigOf(portal)).topUpEnabled === true
}
