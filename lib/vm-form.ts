import { expect, type Locator } from '@playwright/test'

// The Create VM form (titan-ops features/vm/design.md#vm-create-form): once cluster and network are both chosen they
// show on one line under the title with a Change button, and their selects open on Change; while one is missing the
// selects show by themselves. Template and size are radio groups whose radios carry the id as value; with templates of
// two operating systems or more, only the open family's templates are on the page.
// The words are the form's in the page's language (OpenViCloud/titan-cloud-console:portal/src/i18n/en.ts, vi.ts:
// vmCreate.cluster, network, template, size, changeLocation, submit).
export type VmFormWords = { cluster: string, network: string, template: string, size: string, change: string, submit: string }

export const VM_FORM_EN: VmFormWords = {
  cluster: 'Cluster', network: 'Network', template: 'Template', size: 'Size', change: 'Change', submit: 'Create VM',
}
export const VM_FORM_VI: VmFormWords = {
  cluster: 'Cluster', network: 'Mạng', template: 'Template', size: 'Cấu hình', change: 'Đổi', submit: 'Tạo VM',
}

// Opens the cluster and network selects if they sit behind Change, then picks the cluster and, if given, the network.
export async function chooseLocation(dialog: Locator, words: VmFormWords, clusterId: string, networkId?: string): Promise<void> {
  // Create VM turns enabled once a usable network is listed (every caller makes one first); until then the selects
  // can still fold into the line.
  await expect(dialog.getByRole('button', { name: words.submit, exact: true })).toBeEnabled()
  const cluster = dialog.getByRole('combobox', { name: words.cluster, exact: true })
  const change = dialog.getByRole('button', { name: words.change, exact: true })
  // Either shows once the clusters have loaded; both show when the selects are already open.
  await expect(cluster.or(change).first()).toBeVisible()
  if (!(await cluster.isVisible())) {
    await change.click()
  }
  await cluster.selectOption(clusterId)
  if (networkId !== undefined) {
    await dialog.getByRole('combobox', { name: words.network, exact: true }).selectOption(networkId)
  }
}

export function radioOf(dialog: Locator, group: string, id: string): Locator {
  return dialog.getByRole('radiogroup', { name: group, exact: true }).locator(`input[type="radio"][value="${id}"]`)
}

// Picks a template by id, opening the family it is in when the family column shows.
export async function chooseTemplate(dialog: Locator, words: VmFormWords, templateId: string): Promise<void> {
  const radio = radioOf(dialog, words.template, templateId)
  await expect(dialog.getByRole('radiogroup', { name: words.template, exact: true })).toBeVisible()
  const families = dialog.locator('button[aria-pressed]')
  for (let i = 0; i < await families.count() && await radio.count() === 0; i++) {
    await families.nth(i).click()
  }
  await radio.check()
}

// Picks the template and the size by id.
export async function chooseTemplateAndSize(dialog: Locator, words: VmFormWords, templateId: string, tier: string): Promise<void> {
  await chooseTemplate(dialog, words, templateId)
  await radioOf(dialog, words.size, tier).check()
}
