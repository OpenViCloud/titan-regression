import { test, expect } from '@playwright/test'
import { ADMIN, closeSessions, pageOf, useBrowser } from './auth'
import { log, RESULTS, startLog } from './api'

// Cases ADM-17, ADM-18 of plan.md: the operator metrics tier as the runner sees it inside the cluster (no token: the
// services are cluster-internal), and the admin portal's link to it. ADM-17 reads two cluster-internal services, so it
// runs only in the runner pod; opening the link from outside on the release environment is CON-16 (contract).
const VICTORIA_METRICS = 'http://victoria-metrics.monitoring.svc:8428'
const VMALERT = 'http://vmalert.monitoring.svc:8880'

// OpenViCloud/titan-local-cluster:base/monitoring/scrape.yml (job_name) — the jobs every environment scrapes; traefik only
// where the cluster runs Traefik, so it is neither required nor refused.
const REQUIRED_JOBS = ['node', 'kube-state-metrics', 'postgres', 'control-plane', 'incus']
// OpenViCloud/titan-local-cluster:base/monitoring/vmalert-values.yaml (group titan)
const TITAN_RULES = ['NodeMemoryHigh', 'NodeDiskFull', 'PodRestarting', 'ControlPlane5xx', 'PostgresDown']

async function getJson(url: string): Promise<any> {
  const reply = await fetch(url)
  const text = await reply.text()
  log(`GET ${url} ${reply.status} ${text.length} bytes`)
  expect(reply.status, url).toBe(200)
  return JSON.parse(text)
}

test.describe.serial('admin-metrics', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  test.beforeAll(async ({ browser }) => {
    startLog('admin-metrics')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    const page = await pageOf('admin')
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    await closeSessions()
  })

  // titan-ops architecture/operator-metrics.md#metrics-tier · titan-ops architecture/operator-metrics.md#operator-alerts ·
  // OpenViCloud/titan-local-cluster:base/monitoring/scrape.yml (job_name) · OpenViCloud/titan-local-cluster:base/monitoring/vmalert-values.yaml (group titan)
  test('ADM-17 every scrape target is up and covers the five jobs; group titan has exactly its five rules and none is firing', async () => {
    const targets = (await getJson(`${VICTORIA_METRICS}/api/v1/targets`)).data.activeTargets as Array<{ labels: Record<string, string>, health: string, scrapeUrl: string, lastError?: string }>
    for (const t of targets) {
      log(`ADM-17 target ${t.labels.job} ${t.health} ${t.scrapeUrl}${t.lastError ? ` (${t.lastError})` : ''}`)
    }
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.filter((t) => t.health !== 'up').map((t) => `${t.labels.job} ${t.scrapeUrl}`)).toEqual([])
    const jobs = new Set(targets.map((t) => t.labels.job))
    for (const job of REQUIRED_JOBS) {
      expect(jobs.has(job), `a target of job ${job}`).toBe(true)
    }

    const groups = (await getJson(`${VMALERT}/api/v1/rules`)).data.groups as Array<{ name: string, rules: Array<{ name: string, state: string }> }>
    const titan = groups.filter((g) => g.name === 'titan')
    expect(titan.length, 'one group titan').toBe(1)
    log(`ADM-17 group titan: ${titan[0].rules.map((r) => `${r.name}=${r.state}`).join(', ')}`)
    expect(titan[0].rules.map((r) => r.name).sort()).toEqual([...TITAN_RULES].sort())
    expect(titan[0].rules.filter((r) => r.state === 'firing').map((r) => r.name)).toEqual([])
  })

  // titan-ops architecture/operator-metrics.md#vmui-access ·
  // OpenViCloud/titan-admin-console:portal/src/admin/layout/AdminLayout.test.tsx ("links to the metrics tool in a new tab when the environment has one") ·
  // OpenViCloud/titan-admin-console:portal/src/admin/layout/AdminLayout.tsx (sidebarFooter: href = getConfig().metricsUrl)
  test('ADM-18 the admin portal sidebar footer links to metricsUrl of its config.json in a new tab, outside the main nav', async () => {
    const page = await pageOf('admin')
    await page.goto(ADMIN + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem('ovc-lang', 'en'))
    await page.goto(ADMIN + '/', { waitUntil: 'networkidle' })
    const config = await page.evaluate(async () => (await fetch('/config.json', { cache: 'no-store' })).json())
    log(`ADM-18 config.json metricsUrl=${config.metricsUrl}`)
    expect(typeof config.metricsUrl, 'metricsUrl in the admin portal config.json').toBe('string')

    const link = page.getByRole('link', { name: /Metrics/ })
    await expect(link).toHaveCount(1)
    await page.screenshot({ path: `${RESULTS}/ADM-18-metrics-link.png`, fullPage: true })
    const href = await link.getAttribute('href')
    const target = await link.getAttribute('target')
    const rel = await link.getAttribute('rel')
    log(`ADM-18 link href=${href} target=${target} rel=${rel}`)
    expect(href).toBe(config.metricsUrl)
    expect(target).toBe('_blank')
    expect((rel ?? '').split(/\s+/)).toContain('noopener')
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Metrics/ })).toHaveCount(0)
  })
})
