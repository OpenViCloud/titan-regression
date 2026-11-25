import { test, expect, type Page, type Response } from '@playwright/test'
import { ADMIN, closeSessions, pageOf, useBrowser } from './auth'
import { bodyOf, call, expectStatus, get, log, RESULTS, startLog } from './api'
import { envOf } from './fixtures'

// Cases BAK-01..03, BAK-05..08, BAK-11, BAK-13, BAK-24 and BAK-26 of plan.md: the admin backup target and status API, the
// day's restore drill as GET /v1/admin/backups reads it, and the admin portal's Backups page. BAK-15..17 and BAK-19 are
// kubectl reads by the agent, BAK-12/14 and BAK-25 read the Incus host (Phase 4 of release:regression-prd), BAK-24's
// row of core.provider_commands is the agent's read-only backup/restore-drill.sql before this module, BAK-20 is the job
// backup/command-wait (an agent step), BAK-21 runs in an ops record of titan-ops, not in a release, BAK-22 and BAK-23
// are the job backup/config-again (an agent step, phase4.py bak22), BAK-04 is N/A, BAK-09 is NOT COVERED, BAK-10 is an
// L-x case of a release that restores, BAK-28..36 and BAK-38 are the job backup/restore (an agent step, phase4.py bak28 and bak36) and BAK-27 and BAK-37
// NOT COVERED (plan.md). Runs after `admin`, creates no rg-* resource and changes nothing: the target is the pod's
// configuration (titan-ops features/backup/design.md#backup-target), the drill is the schedule's own.

const STALE_HOURS = 26
const READ_WITHIN_MINUTES = 30

type Wallet = { balance: number, lines: number }

async function walletOf(): Promise<Wallet> {
  const wallet = await get('tenant', '/v1/tenant/wallet')
  const statement = await get('tenant', '/v1/tenant/wallet/statement')
  return { balance: wallet.balance as number, lines: (statement.lines as any[]).length }
}

// A locator text that is the whole text, not a part of it.
function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

function dayOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

// The page's own date and time, in the browser's time zone (OpenViCloud/titan-admin-console:portal/src/lib/money.ts formatDateTime).
async function dateTimeOn(page: Page, iso: string, lang: 'en' | 'vi'): Promise<string> {
  return page.evaluate(([value, l]) => {
    const date = new Date(value)
    if (l === 'vi') {
      const two = (n: number) => String(n).padStart(2, '0')
      return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`
    }
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }, [iso, lang] as const)
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
  // BAK-24's element of restoreDrills when it measured a drill of today verified; BAK-26 reads the page for it.
  let verifiedDrill: any = null

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

  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Backup/Contracts/AdminBackupsResult.cs (readAt, items, restoreDrills),
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
  // item per VM whose instance Incus holds (OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/Vm/Vm.cs HasAnInstance: an externalId,
  // not NotFound, not Deleted; a Creating or Failed VM has no externalId yet, so the status filter below is the same set) and per
  // volume Incus holds as Available (also while it attaches, detaches or deletes; the test checks the Available ones), `name` is the resource's display name, the record is matched by its id;
  // then one item per configured cluster, whether or not it has a config yet: kind `cluster`, the cluster's name, no tenant) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Abstractions/IAdminClusterService.cs (AdminClusterDto: clusterId, name;
  // the same configured clusters, in config order) · titan-ops features/backup/design.md#cluster-backup ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/BackupHealthPolicy.cs (ForDisk: no record ⇒ Missing NoBackup, for a cluster too).
  // An environment with no VM or volume alive measures only the Postgres and cluster items: the VM and volume part is then
  // NOT COVERED (plan.md), logged here for the report.
  test('BAK-11 one item per VM Incus holds, per volume of beta-user Available and per cluster, with a tenant (none for a cluster) and a string health', async () => {
    const vms = (await get('admin', '/v1/admin/vms') as any[]).filter((v) => !['Creating', 'NotFound', 'Failed', 'Deleted'].includes(v.status))
    const volumes = (await get('tenant', '/v1/tenant/volumes') as any[]).filter((v) => v.status === 'Available')
    const clusters = await get('admin', '/v1/admin/clusters') as any[]
    const tenant = await get('tenant', '/v1/tenant')
    log(`BAK-11 vms=${vms.length} volumes(beta-user)=${volumes.length} clusters=${clusters.map((c) => c.name).join(',')} diskItems=${diskItems.length}`)
    const vmItems = diskItems.filter((i) => i.kind === 'vm')
    const volumeItems = diskItems.filter((i) => i.kind === 'volume')
    const clusterItems = diskItems.filter((i) => i.kind === 'cluster')
    expect(diskItems.filter((i) => !['vm', 'volume', 'cluster'].includes(i.kind)), 'no item of another kind after Postgres').toEqual([])
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
    expect(clusters.length, 'GET /v1/admin/clusters lists the configured clusters').toBeGreaterThan(0)
    for (const cluster of clusters) {
      const mine = clusterItems.filter((i) => i.name === cluster.name)
      log(`BAK-11 cluster ${cluster.clusterId} (${cluster.name}): ${mine.map((i) => `health=${i.health} reason=${i.reason} takenAt=${i.takenAt}`).join(' | ')}`)
      expect(mine.length, `cluster ${cluster.name} (${cluster.clusterId})`).toBe(1)
      expect(mine[0].tenantId ?? null, `cluster ${cluster.name}: no tenant`).toBeNull()
    }
    for (const item of clusterItems) {
      expect(clusters.some((c) => c.name === item.name), `item for unknown cluster ${item.name}`).toBe(true)
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
    if (!clusterItems.some((i) => i.health === 'Missing')) {
      log('BAK-11 every cluster has a config backup: the Missing cluster item is not measured this run')
    }
    if (vms.length === 0 && volumes.length === 0) {
      log('BAK-11 NOT COVERED for the VM and volume part: no VM or volume Exists on this environment during the module')
    }
  })

  // titan-ops features/backup/design.md#backups-page · titan-ops features/backup/design.md#restore-as-new-resource ·
  // OpenViCloud/titan-admin-console:portal/src/admin/pages/AdminBackupsPage.tsx (AdminBackupsPage: the intro under the title, the
  // restore section's body and RUNBOOK_REF in a <code>, no link; BackupTargetBlock, BackupTargetValues: plain text, no inputs;
  // BackupTable and restorable: a Restore button only on a vm or volume row with a resourceId and at least one archive) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Platform/Backup/Contracts/BackupItemQueryResult.cs (ResourceId, Archives:
  // none for Postgres and a cluster) · strings in OpenViCloud/titan-admin-console:portal/src/i18n/en.ts and
  // OpenViCloud/titan-admin-console:portal/src/i18n/vi.ts (adminBackups: title, intro, restoreTitle, restoreBody, runbookName,
  // restoreAction). The language is kept in localStorage `ovc-lang` (OpenViCloud/titan-admin-console:portal/src/i18n/lang.ts).
  // The Stale/Missing banner and "Show them" are NOT COVERED (plan.md).
  test('BAK-08 the Backups page shows the target read-only, the base age, Restore only where a backup is, the runbook name, in English then Vietnamese', async () => {
    const page = await pageOf('admin')
    const runbook = 'titan-ops infra/oci/runbook.md#disaster-recovery'
    const expected = {
      en: {
        title: 'Backups', target: 'Backup target', base: 'Newest base backup', restore: 'Restoring', restoreAction: 'Restore',
        table: 'Newest backup of each resource',
        intro: 'The newest backup of what Titan protects, read from the backup bucket. A VM or a volume can be restored from here as a new resource; restoring the database or a whole cluster runs outside the console.',
        restoreBody: 'A database restore runs outside this console, from the disaster recovery runbook.',
        runbookLine: `Disaster recovery runbook: ${runbook}`,
        ago: /^(\d+) (minute|minutes|hour|hours|days) ago$|^None yet$/,
      },
      vi: {
        title: 'Sao lưu', target: 'Đích sao lưu', base: 'Bản sao lưu gốc mới nhất', restore: 'Khôi phục', restoreAction: 'Khôi phục',
        table: 'Bản sao lưu mới nhất của từng tài nguyên',
        intro: 'Bản sao lưu mới nhất của những gì Titan bảo vệ, đọc từ bucket sao lưu. Có thể khôi phục một VM hoặc một ổ đĩa ngay tại đây thành một tài nguyên mới; khôi phục cơ sở dữ liệu hay cả một cluster thì chạy ngoài console.',
        restoreBody: 'Khôi phục cơ sở dữ liệu chạy ngoài console, theo runbook khôi phục sau thảm hoạ.',
        runbookLine: `Runbook khôi phục sau thảm hoạ: ${runbook}`,
        ago: /^(\d+) (phút|giờ|ngày) trước$|^Chưa có$/,
      },
    }
    // Delete, Download, back up now and Save, in either language; Restore is checked row by row below.
    const forbidden = /\b(delete|download|save|back ?up now)\b|^(xoá|xóa|tải xuống|lưu|sao lưu ngay)$/i
    // Every answer of the backup target the page reads, on each load: no secret in the response either.
    const targetBodies: Array<Promise<string>> = []
    const onResponse = (response: Response): void => {
      if (response.url().includes('/v1/admin/backup-target')) {
        targetBodies.push(response.text().then((text) => text.toLowerCase(), () => ''))
      }
    }
    page.on('response', onResponse)
    // The same page as a fresh load: the language must hold.
    const checkLanguageHeld = async (lang: 'en' | 'vi'): Promise<void> => {
      const words = expected[lang]
      await expect(page.getByRole('heading', { level: 1, name: words.title })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(lang)
      await expect(page.locator('h1 + p')).toHaveText(words.intro)
      await expect(page.locator('section[aria-labelledby="backups-restore"] p')).toHaveText([words.restoreBody, words.runbookLine])
    }
    for (const lang of ['en', 'vi'] as const) {
      await setLanguage(page, lang)
      const words = expected[lang]
      await checkLanguageHeld(lang)
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
      await expect(restore.locator('code')).toHaveText(runbook)
      expect(await restore.locator('a').count()).toBe(0)

      // Restore: one button on each vm or volume row with an archive, none on any other row (Postgres, cluster, a disk
      // without an archive). Items are read again here: a backup may have landed since BAK-06.
      await expect(page.getByRole('table', { name: words.table })).toBeVisible()
      const rows = page.getByRole('row')
      const rowOf = (name: string) => rows.filter({ has: page.locator('td:first-child', { hasText: exactly(name) }) })
      await expect(rowOf('titan-db')).toHaveCount(1)
      const items = (await get('admin', '/v1/admin/backups')).items as any[]
      const hasArchive = (i: any) => (i.kind === 'vm' || i.kind === 'volume') && i.resourceId != null && (i.archives ?? []).length > 0
      const names = [...new Set(items.map((i) => i.name as string))]
      for (const name of names) {
        const mine = items.filter((i) => i.name === name)
        const want = mine.filter(hasArchive).length
        log(`BAK-08 ${lang} row ${name}: ${mine.map((i) => `${i.kind} archives=${(i.archives ?? []).length}`).join(', ')} → Restore ×${want}`)
        await expect(rowOf(name), `${name}: one row per item`).toHaveCount(mine.length)
        await expect(rowOf(name).getByRole('button', { name: words.restoreAction, exact: true }), `${name}: Restore buttons`).toHaveCount(want)
      }
      const restorable = items.filter(hasArchive).length
      if (restorable === 0) {
        log(`BAK-08 ${lang}: no VM or volume item has an archive: the Restore button's presence is not measured this run, only its absence`)
      }
      const buttons = await page.getByRole('button').evaluateAll((els) =>
        els.map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim()))
      log(`BAK-08 ${lang} buttons ${JSON.stringify(buttons)}`)
      expect(buttons.filter((b) => forbidden.test(b)), 'no Delete, Download, back up now or Save').toEqual([])
      expect(buttons.filter((b) => b === words.restoreAction).length, 'every Restore button is a row button').toBe(restorable)

      const html = (await page.content()).toLowerCase()
      expect(html).not.toContain('secretaccesskey')
      await page.screenshot({ path: `${RESULTS}/BAK-08-${lang}.png` })

      await page.reload({ waitUntil: 'networkidle' })
      await checkLanguageHeld(lang)
      await page.screenshot({ path: `${RESULTS}/BAK-08-${lang}-reload.png` })
    }
    page.off('response', onResponse)
    const bodies = await Promise.all(targetBodies)
    log(`BAK-08 backup-target responses=${bodies.length}`)
    expect(bodies.length, 'the page read the backup target').toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body).not.toContain('secret')
    }
    await setLanguage(page, 'en')
  })

  // OpenViCloud/titan-admin-console:portal/src/admin/pages/AdminBackupsPage.tsx (BackupTable: one row per item, the name in the
  // first cell; the tenant column the tenant's name from GET /v1/tenants (useAdminTenants), a dash for an item without a
  // tenant — Postgres and every cluster; the kind label t.adminBackups.kinds; the reason text t.adminBackups.reasons);
  // labels in OpenViCloud/titan-admin-console:portal/src/i18n/en.ts and OpenViCloud/titan-admin-console:portal/src/i18n/vi.ts
  // (adminBackups.kinds: vm VM/VM, volume Volume/Ổ đĩa, cluster Cluster config/Cấu hình cụm; reasons.NoBackup). Needs a
  // VM, volume or cluster item from BAK-11.
  test('BAK-13 disk and cluster rows show the tenant name or a dash, the kind label and the reason, in English then Vietnamese', async () => {
    test.skip(diskItems.length === 0, 'NOT COVERED: no VM, volume or cluster backup item on this environment during the module')
    const page = await pageOf('admin')
    const tenantNames = new Map((await get('admin', '/v1/tenants') as any[]).map((t) => [t.id as string, t.name as string]))
    const labels = {
      en: { vm: 'VM', volume: 'Volume', cluster: 'Cluster config', noBackup: 'No backup found.' },
      vi: { vm: 'VM', volume: 'Ổ đĩa', cluster: 'Cấu hình cụm', noBackup: 'Không thấy bản sao lưu nào.' },
    }
    for (const lang of ['en', 'vi'] as const) {
      await setLanguage(page, lang)
      const rows = page.getByRole('row')
      const rowOf = (name: string) => rows.filter({ has: page.locator('td:first-child', { hasText: exactly(name) }) })
      await expect(rowOf('titan-db').locator('[data-column="tenant"]')).toHaveText('—')
      for (const item of diskItems) {
        const kind = item.kind as 'vm' | 'volume' | 'cluster'
        const row = rowOf(item.name)
        await expect(row, `${kind} ${item.name}: one row`).toHaveCount(1)
        if (kind === 'cluster') {
          await expect(row.locator('[data-column="tenant"]')).toHaveText('—')
        } else {
          expect(tenantNames.has(item.tenantId), `${kind} ${item.name}: tenant ${item.tenantId} in GET /v1/tenants`).toBe(true)
          await expect(row.locator('[data-column="tenant"]')).toHaveText(tenantNames.get(item.tenantId) as string)
        }
        await expect(row.locator('td').nth(2)).toHaveText(labels[lang][kind])
        if (item.health === 'Missing') {
          await expect(row).toContainText(labels[lang].noBackup)
        }
      }
      const clusterRow = diskItems.find((i) => i.kind === 'cluster')
      if (clusterRow !== undefined) {
        await rowOf(clusterRow.name).scrollIntoViewIfNeeded()
      }
      await page.screenshot({ path: `${RESULTS}/BAK-13-${lang}.png` })
    }
    await setLanguage(page, 'en')
  })

  // titan-ops features/backup/design.md#restore-drill ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Backup/ListRestoreDrillsQueryHandler.cs (HandleAsync: one line
  // per configured cluster; the newest Done or Failed restore.drill row of 30 days decides: Done ⇒ verified, VerifiedAt its
  // CreatedAt, Kind and Name from the payload, no Reason; Failed ⇒ notVerified with LastError; none ⇒ none) ·
  // OpenViCloud/titan-control-plane:Titan.Application/Queries/Admin/Backup/Contracts/RestoreDrillQueryResult.cs ·
  // OpenViCloud/titan-control-plane:Titan.Application/Commands/Admin/Backup/ScheduleBackupsCommandHandler.cs (AskRestoreDrillAsync:
  // kind vm or volume) · OpenViCloud/titan-control-plane:Titan.Domain/Aggregates/ProviderCommand/Enums/BackupCommandKeys.cs
  // (RestoreDrill: one key per cluster per UTC day). The row's SQL part (one row for today's key, kind, no tenant or
  // resource, status, payload, the drilled disk's backup of today) is the agent's backup/restore-drill.sql, read before
  // this module; it compares the payload's kind and name with the `BAK-24 drill` line. A drill that is not verified today
  // is NOT COVERED here, its verdict that read's (Failed ⇒ FAIL), since the API does not say which day a failed drill was.
  test('BAK-24 restoreDrills has one element for the cluster: verified today, with the drilled disk kind and name and no reason', async () => {
    const { clusterId } = await envOf()
    const backups = await get('admin', '/v1/admin/backups')
    const drills = backups.restoreDrills as any[] | undefined
    log(`BAK-24 restoreDrills=${JSON.stringify(drills)}`)
    expect(Array.isArray(drills), 'restoreDrills in GET /v1/admin/backups').toBe(true)
    const mine = drills!.filter((d) => d.clusterId === clusterId)
    expect(mine, `one element for cluster ${clusterId}`).toHaveLength(1)
    const drill = mine[0]
    const today = new Date().toISOString().slice(0, 10)
    test.skip(drill.state === 'none',
      `NOT COVERED: no restore drill of cluster ${clusterId} ended in the last 30 days (RestoreDrill:Enabled off, or no pass saw every disk end)`)
    if (drill.state === 'notVerified') {
      const deletedHeldVm = String(drill.name ?? '').startsWith('rg-bak22-') && String(drill.reason ?? '').includes('is not in project')
      test.skip(true, deletedHeldVm
        ? `NOT COVERED: the newest drill named ${drill.name}, the VM job backup/config-again deletes at its end (${drill.reason})`
        : `NOT COVERED by the spec: the newest drill of cluster ${clusterId} failed (${drill.kind} ${drill.name}: ${drill.reason}); ` +
          'the agent\'s read of today\'s row is the verdict: Failed today ⇒ FAIL')
    }
    test.skip(drill.state === 'verified' && dayOf(drill.verifiedAt) !== today,
      `NOT COVERED: the newest verified drill of cluster ${clusterId} is of ${drill.verifiedAt}, none of today (${today}) has ended yet`)
    log(`BAK-24 drill cluster=${clusterId} kind=${drill.kind} name=${drill.name} verifiedAt=${drill.verifiedAt}`)
    expect(drill.state).toBe('verified')
    expect(['vm', 'volume']).toContain(drill.kind)
    expect(typeof drill.name).toBe('string')
    expect((drill.name as string).length).toBeGreaterThan(0)
    expect(dayOf(drill.verifiedAt)).toBe(today)
    expect(drill.reason ?? null).toBeNull()
    verifiedDrill = drill
  })

  // titan-ops features/backup/design.md#backups-page · OpenViCloud/titan-admin-console:portal/src/admin/pages/AdminBackupsPage.tsx
  // (RestoreDrillBlock: a section labelled by its title, one <li> per cluster, the cluster's name then RestoreDrillLine:
  // restoreDrillVerified(`${kinds[kind]} ${name}`, f.dateTime(verifiedAt))) · strings in
  // OpenViCloud/titan-admin-console:portal/src/i18n/en.ts and OpenViCloud/titan-admin-console:portal/src/i18n/vi.ts
  // (adminBackups.restoreDrillTitle, restoreDrillVerified, kinds) · OpenViCloud/titan-admin-console:portal/src/lib/money.ts
  // (formatDateTime). The cluster's name is GET /v1/admin/clusters' (OpenViCloud/titan-control-plane:Titan.Application/Abstractions/IAdminClusterService.cs
  // AdminClusterDto). The failed and the never-run lines are NOT COVERED (plan.md); so is this case when BAK-24 measured nothing.
  test('BAK-26 the Latest verified restore block names the cluster, the drilled disk and when, in English then Vietnamese', async () => {
    test.skip(verifiedDrill === null, 'NOT COVERED: BAK-24 measured no drill verified today')
    const drill = verifiedDrill
    const cluster = (await get('admin', '/v1/admin/clusters') as any[]).find((c) => c.clusterId === drill.clusterId)
    expect(cluster, `cluster ${drill.clusterId} in GET /v1/admin/clusters`).toBeDefined()
    const page = await pageOf('admin')
    const words = {
      en: {
        title: 'Latest verified restore', kinds: { vm: 'VM', volume: 'Volume' } as Record<string, string>,
        verified: (what: string, when: string) => `${what} was restored from its backup on ${when}.`,
      },
      vi: {
        title: 'Lần khôi phục đã xác minh gần nhất', kinds: { vm: 'VM', volume: 'Ổ đĩa' } as Record<string, string>,
        verified: (what: string, when: string) => `${what} đã được khôi phục từ bản sao lưu lúc ${when}.`,
      },
    }
    for (const lang of ['en', 'vi'] as const) {
      await setLanguage(page, lang)
      const sentence = words[lang].verified(`${words[lang].kinds[drill.kind]} ${drill.name}`, await dateTimeOn(page, drill.verifiedAt, lang))
      for (const load of ['first', 'reload']) {
        if (load === 'reload') {
          await page.reload({ waitUntil: 'networkidle' })
        }
        const block = page.locator('section[aria-labelledby="backups-restore-drill"]')
        await expect(block.getByRole('heading', { name: words[lang].title })).toBeVisible()
        const line = block.locator('li', { has: page.locator('span', { hasText: exactly(cluster.name) }) })
        await expect(line, `${lang} ${load}: one line for ${cluster.name}`).toHaveCount(1)
        log(`BAK-26 ${lang} ${load}: "${((await line.textContent()) ?? '').trim()}" want "${sentence}"`)
        await expect(line.locator('p')).toHaveText(sentence)
        await block.scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${RESULTS}/BAK-26-${lang}-${load}.png` })
      }
    }
    await setLanguage(page, 'en')
  })
})
