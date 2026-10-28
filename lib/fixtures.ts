import { expect } from '@playwright/test'
import { bodyOf, call, expectStatus, get, log, newKey, pollUntil } from './api'

// Every name starts with rg- so the cleanup module finds it.
export const RUN = Date.now().toString(36)

export function nameOf(kind: string): string {
  return `rg-${kind}-${RUN}`
}

// The shared run network: a test tenant may hold one network (MaxNetworks = 1), so every module of a lane uses the same one.
export const RUN_NETWORK_PREFIX = 'rg-net-'
export const RUN_CIDR = '10.76.0.0/24'

// --- environment: cluster, template, tiers ----------------------------------------------------------------------

export type Env = {
  clusterId: string
  templateId: string
  smallTier: string
  otherTier: string
  volumeOfferingId: string
}

let env: Env | null = null

// The first cluster whose customer catalog lists a template: dev has local (arm64 on macOS: only Ubuntu syncs; amd64 on
// Ubuntu: all three do); prd has singapore01.
export async function envOf(): Promise<Env> {
  if (env !== null) {
    return env
  }
  const clusters = await get('anonymous', '/v1/clusters') as Array<{ id: string }>
  let clusterId = ''
  let templateId = ''
  for (const cluster of clusters) {
    const templates = await get('tenant', `/v1/templates?clusterId=${cluster.id}`) as Array<{ id: string }>
    if (templates.length > 0) {
      clusterId = cluster.id
      templateId = templates[0].id
      break
    }
  }
  expect(clusterId, 'some cluster must list a template').not.toEqual('')
  // Smallest first: dev's Incus host has 7 GiB, so the two smallest tiers are the ones that fit side by side.
  const tiers = (await get('anonymous', '/v1/vm-offerings') as Array<{ id: string, memoryMb: number }>)
    .sort((a, b) => a.memoryMb - b.memoryMb)
  const volumeOfferings = await get('anonymous', '/v1/volume-offerings') as Array<{ id: string }>
  env = { clusterId, templateId, smallTier: tiers[0].id, otherTier: tiers[1].id, volumeOfferingId: volumeOfferings[0].id }
  log(`env cluster=${env.clusterId} template=${env.templateId} tiers=${env.smallTier},${env.otherTier} volumeOffering=${env.volumeOfferingId}`)
  return env
}

// --- shapes for the log --------------------------------------------------------------------------------------

export function vmShape(vm: any): string {
  return `state=${vm.currentState} existence=${vm.currentExistence} desired=${vm.desiredState}/${vm.desiredExistence} transition=${vm.transition} ip=${vm.ipAddress} failure=${vm.requestFailureReason}`
}

export function existenceShape(r: any): string {
  return `state=${r.currentState} existence=${r.currentExistence} desired=${r.desiredExistence} transition=${r.transition} failure=${r.requestFailureReason}`
}

export function volumeShape(v: any): string {
  return `existence=${v.currentExistence} desired=${v.desiredExistence} attached=${v.currentAttachedVmId} wants=${v.desiredAttachedVmId} elsewhere=${v.currentAttachedElsewhere} transition=${v.transition} failure=${v.requestFailureReason}`
}

export function runs(vm: any): boolean {
  return vm.currentState === 'Running' || vm.currentState === 'Ready'
}

// --- network -------------------------------------------------------------------------------------------------

export async function listNetworks(): Promise<any[]> {
  return await get('tenant', '/v1/tenant/networks') as any[]
}

export async function waitNetwork(label: string, id: string, done: (n: any) => boolean): Promise<any> {
  return pollUntil(label, () => get('tenant', `/v1/tenant/networks/${id}`), done, existenceShape)
}

export function networkUsable(n: any): boolean {
  return n.currentState === 'Created' && n.currentExistence === 'Exists' && n.transition === null
}

// Finds the run network a module before left, or creates one. Never deletes it: network-lifecycle does.
export async function runNetwork(): Promise<{ id: string, name: string }> {
  const live = (await listNetworks()).filter((n) => n.name.startsWith(RUN_NETWORK_PREFIX) && n.desiredExistence === 'Exists')
  if (live.length > 0) {
    const found = await waitNetwork('run network', live[0].id, networkUsable)
    return { id: found.id, name: found.name }
  }
  const { clusterId } = await envOf()
  const name = `${RUN_NETWORK_PREFIX}${RUN}`
  const reply = await call('tenant', 'POST', '/v1/tenant/networks', { name, clusterId, cidr: RUN_CIDR }, newKey())
  expectStatus(reply, 202)
  const id = bodyOf(reply).networkId as string
  await waitNetwork('run network created', id, networkUsable)
  return { id, name }
}

// --- vm ------------------------------------------------------------------------------------------------------

export async function getVm(id: string): Promise<any> {
  return get('tenant', `/v1/tenant/vms/${id}`)
}

export async function waitVm(label: string, id: string, done: (vm: any) => boolean): Promise<any> {
  return pollUntil(label, () => getVm(id), done, vmShape)
}

export async function createVm(name: string, tier: string, networkId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { clusterId, templateId } = await envOf()
  const reply = await call('tenant', 'POST', '/v1/tenant/vms',
    { name, networkId, vmOfferingId: tier, templateId, clusterId, diskSizeGb: null, ...extra }, newKey())
  expectStatus(reply, 202)
  // A create answers the id only (OpenViCloud/titan-ops:docs/architecture/http-contract.md#create-returns-id).
  expect(Object.keys(bodyOf(reply))).toEqual(['vmId'])
  return bodyOf(reply).vmId as string
}

export async function deleteVmAndWait(id: string): Promise<void> {
  const vm = await getVm(id)
  if (vm.currentExistence === 'Deleted') {
    return
  }
  expectStatus(await call('tenant', 'DELETE', `/v1/tenant/vms/${id}`), 202)
  await waitVm('vm deleted', id, (v) => v.currentExistence === 'Deleted')
}

// --- volume --------------------------------------------------------------------------------------------------

export async function readVolume(id: string): Promise<any> {
  const rows = await get('tenant', '/v1/tenant/volumes') as any[]
  const row = rows.find((r) => r.id === id)
  if (row === undefined) {
    return { currentExistence: 'Deleted' }
  }
  return row
}

export async function waitVolume(label: string, id: string, done: (v: any) => boolean): Promise<any> {
  return pollUntil(label, () => readVolume(id), done, volumeShape)
}

// --- activity ------------------------------------------------------------------------------------------------

// The feed holds the 50 newest rows (OpenViCloud/titan-ops:docs/features/activity/design.md#activity-data-and-route), so a module reads
// it right after its own requests and counts rows by the resource name it made.
export async function activityOf(resourceName: string): Promise<string[]> {
  const rows = await get('tenant', '/v1/tenant/activity?limit=50') as Array<{ action: string, resourceName: string }>
  return rows.filter((r) => r.resourceName === resourceName).map((r) => r.action)
}

export function countOf(actions: string[], action: string): number {
  return actions.filter((a) => a === action).length
}
