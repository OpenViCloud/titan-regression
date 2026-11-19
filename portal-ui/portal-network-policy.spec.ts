import { test, expect, type Page, type Request } from '@playwright/test'
import { PORTAL, closeSessions, pageOf, useBrowser } from './auth'
import { API, RESULTS, get, log, startLog } from './api'
import { cleanUp } from './clean-up'
import { runNetwork } from './fixtures'

// Case UI-41 of plan.md: the default policy lines of the Firewall panel on /networks, and the firewall hints of the
// Create Network and Create load balancer forms. Nothing is created: the run network is the one the lane shares, and a
// network with Allow/Allow is measured only when one of the run already exists.

// The words in each language (OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts:
// networks.listLabel, networks.firewall, networks.create, networkCreate.title, networkCreate.enableIpv6Hint,
// loadBalancers.create, loadBalancerForm.createTitle, loadBalancerForm.firewallHint, firewall.inboundBlocked,
// firewall.inboundAllowed, firewall.outboundAllowed).
const WORDS = {
  en: {
    lang: 'en' as const,
    listLabel: 'Networks',
    firewall: 'Firewall',
    inboundBlocked: 'Inbound from outside the network: blocked unless a rule allows it',
    inboundAllowed: 'Inbound from outside the network: allowed',
    outboundAllowed: 'Outbound: allowed',
    createNetwork: 'Create Network',
    networkTitle: 'Create Network',
    ipv6Hint: 'The network gets its own /64, and each VM on it gets a public IPv6 address. Traffic from the Internet is blocked until you add a firewall rule — for example Ingress TCP 22 for SSH.',
    createLoadBalancer: 'Create load balancer',
    loadBalancerTitle: 'Create load balancer',
    loadBalancerHint: 'If the network firewall blocks inbound traffic (the default for new networks), add an Ingress rule for each target port.',
  },
  vi: {
    lang: 'vi' as const,
    listLabel: 'Mạng',
    firewall: 'Tường lửa',
    inboundBlocked: 'Chiều vào từ ngoài mạng: bị chặn trừ khi có quy tắc cho phép',
    inboundAllowed: 'Chiều vào từ ngoài mạng: cho phép',
    outboundAllowed: 'Chiều ra: cho phép',
    createNetwork: 'Tạo mạng',
    networkTitle: 'Tạo mạng',
    ipv6Hint: 'Mạng có một dải /64 riêng, và mỗi máy ảo trong mạng nhận một địa chỉ IPv6 công khai. Lưu lượng từ Internet bị chặn cho tới khi bạn thêm quy tắc tường lửa — ví dụ Ingress TCP 22 để SSH.',
    createLoadBalancer: 'Tạo load balancer',
    loadBalancerTitle: 'Tạo load balancer',
    loadBalancerHint: 'Nếu tường lửa của mạng chặn chiều vào (mặc định của mạng mới), hãy thêm quy tắc Ingress cho từng target port.',
  },
}

type Words = typeof WORDS.en | typeof WORDS.vi
type Net = { id: string, name: string, status: string, defaultIngressPolicy: string, defaultEgressPolicy: string }

async function useLanguage(page: Page, path: string, lang: 'en' | 'vi'): Promise<void> {
  await page.goto(PORTAL + path, { waitUntil: 'networkidle' })
  await page.evaluate((l) => localStorage.setItem('ovc-lang', l), lang)
  await page.reload({ waitUntil: 'networkidle' })
}

// Every request to the API other than a read, from now until stop(): opening and closing a form must send none.
function recordWrites(page: Page): { sent: string[], stop: () => void } {
  const sent: string[] = []
  const apiOrigin = new URL(API).origin
  const onRequest = (req: Request) => {
    if (new URL(req.url()).origin === apiOrigin && req.method() !== 'GET' && req.method() !== 'OPTIONS') {
      sent.push(`${req.method()} ${new URL(req.url()).pathname}`)
    }
  }
  page.on('request', onRequest)
  return { sent, stop: () => page.off('request', onRequest) }
}

// Opens the Firewall panel of one network row and checks its two policy lines.
async function checkPanel(page: Page, words: Words, net: Net, inbound: string, label: string): Promise<void> {
  const row = page.getByRole('list', { name: words.listLabel, exact: true }).getByRole('listitem')
    .filter({ has: page.getByText(net.name, { exact: true }) })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: words.firewall, exact: true }).click()
  await expect(row.getByText(inbound, { exact: true })).toBeVisible()
  await expect(row.getByText(words.outboundAllowed, { exact: true })).toBeVisible()
  await page.screenshot({ path: `${RESULTS}/UI-41-${words.lang}-${label}-panel.png` })
  log(`UI-41 ${words.lang} ${net.name} (${net.defaultIngressPolicy}/${net.defaultEgressPolicy}): "${inbound}", "${words.outboundAllowed}"`)
}

test.describe.serial('portal-ui networks: default firewall policy', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  test.beforeAll(async ({ browser }) => {
    startLog('portal-ui-network-policy')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    await cleanUp([
      // The case switches the language; leave none picked, so the next spec starts from the default.
      ['language', async () => {
        const page = await pageOf('tenant')
        await page.evaluate(() => localStorage.removeItem('ovc-lang'))
      }],
      ['sessions', closeSessions],
    ])
  })

  // titan-ops features/network/user-stories.md#us-f08 · titan-ops features/network/design.md#network-portal ·
  // OpenViCloud/titan-cloud-console:portal/src/pages/NetworkListPage.tsx (FirewallPanel: defaultIngressPolicy 'Deny' ⇒
  // firewall.inboundBlocked, else inboundAllowed; defaultEgressPolicy 'Deny' ⇒ outboundBlocked, else outboundAllowed; the panel
  // opens under the row by its Firewall button) · OpenViCloud/titan-cloud-console:portal/src/components/NetworkCreateModal.tsx
  // (networkCreate.enableIpv6Hint under the #enablePublicIpv6 checkbox, whether ticked or not) ·
  // OpenViCloud/titan-cloud-console:portal/src/components/LoadBalancerFormModal.tsx (loadBalancerForm.firewallHint under the
  // listeners) · OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, OpenViCloud/titan-cloud-console:portal/src/i18n/vi.ts
  // (firewall.inboundBlocked, firewall.inboundAllowed, firewall.outboundAllowed, networkCreate.enableIpv6Hint, loadBalancerForm.firewallHint)
  test('UI-41 the Firewall panel tells the default policy of each network, and the Create Network and Create load balancer forms tell inbound is blocked until a rule allows it, in English then Vietnamese', async () => {
    const run = await runNetwork()
    const networks = await get('tenant', '/v1/tenant/networks') as Net[]
    const runNet = networks.find((n) => n.id === run.id)
    expect(runNet, `run network ${run.name} is listed`).toBeDefined()
    log(`UI-41 run network ${runNet!.name}: ${runNet!.defaultIngressPolicy}/${runNet!.defaultEgressPolicy}`)
    const allowAll = networks.find((n) => n.id !== run.id && n.name.startsWith('rg-')
      && n.status !== 'Deleting' && n.status !== 'Deleted'
      && n.defaultIngressPolicy === 'Allow' && n.defaultEgressPolicy === 'Allow')
    if (allowAll === undefined) {
      log('UI-41 N/A: no live rg-* network with Allow/Allow; the "allowed" inbound line is not measured')
      test.info().annotations.push({ type: 'N/A', description: 'no live rg-* network created with Allow/Allow: the inbound allowed line' })
    } else {
      log(`UI-41 Allow/Allow network ${allowAll.name} ${allowAll.id}`)
    }

    // pageOf() after the API reads: a sign-in closes the old context (auth.ts headersOf).
    const page = await pageOf('tenant')
    for (const words of [WORDS.en, WORDS.vi]) {
      await useLanguage(page, '/networks', words.lang)
      await checkPanel(page, words, runNet!, words.inboundBlocked, 'run')
      if (allowAll !== undefined) {
        await checkPanel(page, words, allowAll, words.inboundAllowed, 'allow')
      }

      const writes = recordWrites(page)
      try {
        await page.getByRole('button', { name: words.createNetwork, exact: true }).click()
        let dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('heading', { name: words.networkTitle, exact: true })).toBeVisible()
        await expect(dialog.locator('#enablePublicIpv6')).not.toBeChecked()
        await expect(dialog.getByText(words.ipv6Hint, { exact: true })).toBeVisible()
        await page.screenshot({ path: `${RESULTS}/UI-41-${words.lang}-network-form.png` })
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)

        await page.goto(PORTAL + '/load-balancers', { waitUntil: 'networkidle' })
        await page.getByRole('button', { name: words.createLoadBalancer, exact: true }).click()
        dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('heading', { name: words.loadBalancerTitle, exact: true })).toBeVisible()
        await expect(dialog.getByText(words.loadBalancerHint, { exact: true })).toBeVisible()
        await page.screenshot({ path: `${RESULTS}/UI-41-${words.lang}-load-balancer-form.png` })
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await page.waitForTimeout(500) // a wrongly-sent request gets a moment to show before its absence is asserted
        expect(writes.sent, `${words.lang}: opening and closing the two forms sends nothing`).toEqual([])
      } finally {
        writes.stop()
      }
      log(`UI-41 ${words.lang}: the IPv6 hint unticked and the load balancer hint shown, nothing sent`)
    }
  })
})
