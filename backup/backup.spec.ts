import { test, expect, type Page } from '@playwright/test'
import { ADMIN, closeSessions, pageOf, useBrowser } from './auth'
import { bodyOf, call, expectStatus, get, log, RESULTS, startLog } from './api'

// Cases BAK-01..03, BAK-05..08, BAK-11 and BAK-13 of plan.md: the admin backup target and status API and the admin
// portal's Backups page. BAK-15..17 and BAK-19 are kubectl reads by the agent, BAK-12/14/18 read the Incus host
// (Phase 4 of release:regression), BAK-04 is N/A, BAK-09 is NOT COVERED, BAK-10 is an L-x case of a release that restores (plan.md). Runs after `admin`, creates no
// rg-* resource and changes nothing: the target is the pod's configuration (titan-ops features/backup/design.md#backup-target).

const STALE_HOURS = 26
const READ_WITHIN_MINUTES = 30

type Wallet = { balance: number, lines: number }

async function walletOf(): Promise<Wallet> {
  const wallet = await get('tenant', '/v1/tenant/wallet')
  const statement = await get('tenant', '/v1/tenant/wallet/statement')
  return { balance: wallet.balance as number, lines: (statement.lines as any[]).length }
}

function hoursSince(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 3_600_000
}

async function setLanguage(page: Page, lang: 'en' | 'vi'): Promise<void> {
  await page.goto(ADMIN + '/backups', { waitUntil: 'networkidle' })
  await page.evaluate((l) => localStorage.setItem('ovc-lang', l), lang)
  await page.reload({ waitUntil: 'networkidle' })
}

test.describe.serial('backup', () => {
  test.describe.configure({ timeout: 10 * 60_000 })

  let target: any = null
  let walletBefore: Wallet | null = null
  let postgres: any = null
  let diskItems: any[] = []

  test.beforeAll(async ({ browser }) => {
    startLog('backup')
    useBrowser(browser)
  })

  test.afterAll(async () => {
    const page = await pageOf('admin')
    await page.goto(ADMIN + '/', { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.removeItem('ovc-lang'))
    await closeSessions()
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/BackupTarget/Contracts/BackupTargetQueryResult.cs;
  // GetBackupTargetQueryHandler never maps the secret (titan-ops features/backup/design.md#backup-target). The ObjectStore
  // of CNPG is compared by the agent (kubectl, evidence/phase4/backup-kubectl.log): the spec logs endpoint and bucket for it.
  test('BAK-01 the admin reads the backup target without any secret', async () => {
    walletBefore = await walletOf()
    target = await get('admin', '/v1/admin/backup-target')
    log(`BAK-01 endpoint=${target.endpoint} region=${target.region} bucket=${target.bucket} accessKeyId.length=${String(target.accessKeyId ?? '').length}`)
    expect(Object.keys(target).sort()).toEqual(['accessKeyId', 'bucket', 'endpoint', 'region'])
    expect(target.endpoint).toMatch(/^https:\/\//)
    for (const value of [target.region, target.bucket, target.accessKeyId]) {
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    }
    const text = JSON.stringify(target).toLowerCase()
    expect(text).not.toContain('secret')
    expect(text).not.toContain('updatedat')
  })

  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/GetBackupTargetEndpoint.cs,
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/ListBackupsEndpoint.cs,
  // OpenViCloud/titan-control-plane:Titan.Infrastructure/Endpoints/Admin/TestBackupTargetEndpoint.cs — Roles("platform-admin"): a tenant is 403, no token is 401.
  test('BAK-02 a tenant gets 403 and no token gets 401 on the three backup routes', async () => {
    const routes: Array<[string, string]> = [['GET', '/v1/admin/backup-target'], ['POST', '/v1/admin/backup-target/test'], ['GET', '/v1/admin/backups']]
    for (const [method, path] of routes) {
      expectStatus(await call('tenant', method, path), 403)
      expectStatus(await call('anonymous', method, path), 401)
    }
  })

  // titan-ops features/backup/design.md#backup-target — the target is the pod's configuration: no PUT route.
  test('BAK-03 PUT on the backup target is 405 and the target is unchanged', async () => {
    expectStatus(await call('admin', 'PUT', '/v1/admin/backup-target', { endpoint: 'https://example.invalid', region: 'auto', bucket: 'rg-none', accessKeyId: 'rg-none', secretAccessKey: 'rg-none' }), 405)
    expect(await get('admin', '/v1/admin/backup-target')).toEqual(target)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Platform/BackupTarget/TestBackupTargetCommandHandler.cs —
  // a real probe (write, list, read back, delete); a target error is 200 {ok:false}. The `_probe/*` object being gone is
  // NOT COVERED here (plan.md: the spec has no bucket key).
  test('BAK-05 Test connection on the configured target probes the bucket', async () => {
    const reply = await call('admin', 'POST', '/v1/admin/backup-target/test')
    expectStatus(reply, 200)
    const result = bodyOf(reply)
    log(`BAK-05 ok=${result.ok} latencyMs=${result.latencyMs} error=${result.error}`)
    expect(result.ok, reply.text).toBe(true)
    expect(result.latencyMs).toBeGreaterThan(0)
    expect(result.error ?? null).toBeNull()
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/Contracts/BackupsQueryResult.cs,
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/BackupHealthPolicy.cs (ForPostgres: Stale after 26 hours of the newest base; the WAL age is information only).
  test('BAK-06 the newest Postgres backup is Ok, recent, sized and read within 30 minutes', async () => {
    const backups = await get('admin', '/v1/admin/backups')
    expect(backups.readAt, JSON.stringify(backups).slice(0, 300)).not.toBeNull()
    expect(hoursSince(backups.readAt) * 60).toBeLessThan(READ_WITHIN_MINUTES)
    const items = backups.items as any[]
    const postgresItems = items.filter((i) => i.kind === 'postgres')
    log(`BAK-06 readAt=${backups.readAt} items=${items.map((i) => `${i.kind}:${i.name}:${i.health}`).join(' ')}`)
    expect(postgresItems.length).toBe(1)
    postgres = postgresItems[0]
    expect(postgres.name).toBe('titan-db')
    expect(typeof postgres.health).toBe('string')
    expect(postgres.health).toBe('Ok')
    expect(hoursSince(postgres.takenAt)).toBeLessThan(STALE_HOURS)
    expect(postgres.sizeBytes).toBeGreaterThan(0)
    expect(postgres.lastWalAt).not.toBeNull()
    diskItems = items.filter((i) => i.kind !== 'postgres')
  })

  // titan-ops features/backup/design.md#backup-is-a-duty — backup is the platform's duty: no wallet or ledger row.
  // The DB side (billing/check-wallets.sql) is the agent's L-s3 after `concurrency`.
  test('BAK-07 the wallet and the ledger of beta-user are unchanged by the backup reads and the probe', async () => {
    const after = await walletOf()
    log(`BAK-07 before=${JSON.stringify(walletBefore)} after=${JSON.stringify(after)}`)
    expect(after).toEqual(walletBefore)
  })

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Backup/ListDiskBackupsQueryHandler.cs (HandleAsync: one
  // item per VM and volume that Exists and has an externalId, `name` is the resource's display name, the record is matched by its id),
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/BackupHealthPolicy.cs (ForDisk). An environment with no VM or volume alive measures only the Postgres item: the disk
  // part is then NOT COVERED (plan.md), logged here for the report.
  test('BAK-11 one item per VM and per volume of beta-user that Exists, with a tenant and a string health', async () => {
    const vms = (await get('admin', '/v1/admin/vms') as any[]).filter((v) => v.currentExistence === 'Exists')
    const volumes = (await get('tenant', '/v1/tenant/volumes') as any[]).filter((v) => v.currentExistence === 'Exists')
    const tenant = await get('tenant', '/v1/tenant')
    log(`BAK-11 vms=${vms.length} volumes(beta-user)=${volumes.length} diskItems=${diskItems.length}`)
    const vmItems = diskItems.filter((i) => i.kind === 'vm')
    const volumeItems = diskItems.filter((i) => i.kind === 'volume')
    for (const vm of vms) {
      const mine = vmItems.filter((i) => i.name === vm.name && i.tenantId === vm.tenantId)
      expect(mine.length, `vm ${vm.name} (${vm.id})`).toBe(1)
    }
    for (const item of vmItems) {
      expect(vms.some((v) => v.name === item.name && v.tenantId === item.tenantId), `item for unknown vm ${item.name}`).toBe(true)
    }
    for (const volume of volumes) {
      const mine = volumeItems.filter((i) => i.name === volume.name && i.tenantId === tenant.id)
      expect(mine.length, `volume ${volume.name} (${volume.id})`).toBe(1)
    }
    for (const item of diskItems) {
      expect(['Ok', 'Stale', 'Missing', 'Unknown']).toContain(item.health)
      if (item.health === 'Ok') {
        expect(hoursSince(item.takenAt), item.name).toBeLessThan(STALE_HOURS)
        expect(item.sizeBytes, item.name).toBeGreaterThan(0)
      }
      if (item.health === 'Missing') {
        expect(item.reason, item.name).toBe('NoBackup')
        expect(item.takenAt, item.name).toBeNull()
      }
    }
    if (vms.length === 0 && volumes.length === 0) {
      log('BAK-11 NOT COVERED for the disk part: no VM or volume Exists on this environment during the module')
    }
  })

  // OpenViCloud/titan-admin-console:portal/src/admin/pages/AdminBackupsPage.tsx (AdminBackupsPage, BackupTargetBlock,
  // BackupTargetValues: plain text, no inputs; the restore section names the runbook in a <code>, no link); strings in
  // OpenViCloud/titan-admin-console:portal/src/i18n/en.ts and OpenViCloud/titan-admin-console:portal/src/i18n/vi.ts (adminBackups). The Stale/Missing banner is NOT COVERED (plan.md).
  test('BAK-08 the Backups page shows the target read-only, the base age, the runbook name, in English then Vietnamese', async () => {
    const page = await pageOf('admin')
    const expected = {
      en: { title: 'Backups', target: 'Backup target', base: 'Newest base backup', restore: 'Restoring', ago: /^(\d+) (minute|minutes|hour|hours|days) ago$|^None yet$/ },
      vi: { title: 'Sao lưu', target: 'Đích sao lưu', base: 'Bản sao lưu gốc mới nhất', restore: 'Khôi phục', ago: /^(\d+) (phút|giờ|ngày) trước$|^Chưa có$/ },
    }
    for (const lang of ['en', 'vi'] as const) {
      await setLanguage(page, lang)
      const words = expected[lang]
      await expect(page.getByRole('heading', { level: 1, name: words.title })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang)
      const targetBlock = page.locator('section[aria-labelledby="backup-target"]')
      await expect(targetBlock.getByRole('heading', { name: words.target })).toBeVisible()
      await expect(targetBlock.locator('dd')).toHaveText([target.endpoint, target.region, target.bucket, target.accessKeyId])
      expect(await targetBlock.locator('input, textarea, select').count()).toBe(0)
      expect(await targetBlock.getByRole('button', { name: /save|lưu/i }).count()).toBe(0)
      const baseCard = page.locator(`section[aria-label="${words.base}"]`)
      const baseText = (await baseCard.locator('p').first().textContent()) ?? ''
      log(`BAK-08 ${lang} base card: "${baseText}" (takenAt ${postgres?.takenAt}, ${hoursSince(postgres.takenAt).toFixed(2)} h ago)`)
      expect(baseText).toMatch(words.ago)
      const hours = baseText.match(/^(\d+) (hour|hours|giờ)/)
      if (hours !== null) {
        expect(Math.abs(Number(hours[1]) - Math.floor(hoursSince(postgres.takenAt)))).toBeLessThanOrEqual(1)
      }
      const restore = page.locator('section[aria-labelledby="backups-restore"]')
      await expect(restore.getByRole('heading', { name: words.restore })).toBeVisible()
      await expect(restore.locator('code')).toHaveText('titan-ops infra/oci/runbook.md#disaster-recovery')
      expect(await restore.locator('a').count()).toBe(0)
      expect(await page.getByRole('button', { name: /restore|delete|download|khôi phục|xoá|tải/i }).count()).toBe(0)
      const html = (await page.content()).toLowerCase()
      expect(html).not.toContain('secretaccesskey')
      await page.screenshot({ path: `${RESULTS}/BAK-08-${lang}.png` })
    }
    await setLanguage(page, 'en')
  })

  // OpenViCloud/titan-admin-console:portal/src/admin/pages/AdminBackupsPage.tsx (BackupTable: tenant name, kind label,
  // reason text; the Postgres row has a dash in the tenant column). Needs a VM or volume item from BAK-11.
  test('BAK-13 disk rows show the tenant name, the kind label and the reason, in English then Vietnamese', async () => {
    test.skip(diskItems.length === 0, 'NOT COVERED: no VM or volume backup item on this environment during the module')
    const page = await pageOf('admin')
    const tenant = await get('tenant', '/v1/tenant')
    const labels = { en: { vm: 'VM', volume: 'Volume', noBackup: 'No backup found.' }, vi: { vm: 'VM', volume: 'Ổ đĩa', noBackup: 'Không thấy bản sao lưu nào.' } }
    for (const lang of ['en', 'vi'] as const) {
      await setLanguage(page, lang)
      const rows = page.getByRole('row')
      await expect(rows.filter({ hasText: 'titan-db' }).locator('[data-column="tenant"]')).toHaveText('—')
      for (const item of diskItems) {
        const row = rows.filter({ has: page.locator('td', { hasText: new RegExp(`^${item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
        await expect(row).toHaveCount(1)
        if (item.tenantId === tenant.id) {
          await expect(row.locator('[data-column="tenant"]')).toHaveText(tenant.name)
        }
        await expect(row).toContainText(labels[lang][item.kind as 'vm' | 'volume'])
        if (item.health === 'Missing') {
          await expect(row).toContainText(labels[lang].noBackup)
        }
      }
      await page.screenshot({ path: `${RESULTS}/BAK-13-${lang}.png` })
    }
    await setLanguage(page, 'en')
  })
})
