import type {
  LicenseBatch,
  LicenseBatchStatus,
  MaterialFile,
  MaterialPackage,
  WorkspaceState,
} from '@/types/domain'
import { findApplicableRule } from './rules'

/**
 * 联合许可批次：把同一收件方的多份资料包、适用规则和许可额度
 * 接成一个批次统一预占、统一核销，避免分别扣减把出口批次拆散。
 */

export const batchStatusLabels: Record<LicenseBatchStatus, string> = {
  reserved: '预占中',
  'pending-review': '待复核',
  licensed: '已核销',
}

export const batchStatusColors: Record<LicenseBatchStatus, string> = {
  reserved: 'processing',
  'pending-review': 'warning',
  licensed: 'success',
}

/** 预占中和待复核的批次都视为活动批次，同一资料包同一时间只能进入一个活动批次。 */
export function isBatchActive(batch: LicenseBatch): boolean {
  return batch.status === 'reserved' || batch.status === 'pending-review'
}

/** 幂等键由资料包集合决定：两个窗口提交同一批资料包时得到同一个键。 */
export function makeBatchIdempotencyKey(packageIds: string[]): string {
  return `joint-batch:${[...packageIds].sort().join('+')}`
}

function hashString(input: string): string {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index)
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/** 资料包内容指纹：申报要素、换版记录、文件引用版本和逐页核对结果共同决定。 */
export function packageFingerprint(
  packageItem: MaterialPackage,
  files: MaterialFile[],
): string {
  const payload = {
    title: packageItem.title,
    category: packageItem.category,
    recipient: packageItem.recipient,
    destination: packageItem.destination,
    endUse: packageItem.endUse,
    technologyTags: packageItem.technologyTags,
    personnelScopes: packageItem.personnelScopes,
    declarations: packageItem.declarations,
    packageVersions: packageItem.versions.length,
    files: files
      .filter((file) => file.packageId === packageItem.id)
      .map((file) => ({
        id: file.id,
        activeVersionId: file.activeVersionId,
        referencedVersionId: file.referencedVersionId,
        versions: file.versions.map((version) => ({
          id: version.id,
          hash: version.hash,
          pages: version.pages.map((page) => [
            page.controlled,
            page.desensitized,
            page.reviewedAt ?? '',
          ]),
        })),
      })),
  }
  return hashString(JSON.stringify(payload))
}

export function batchFingerprints(
  packageIds: string[],
  packages: MaterialPackage[],
  files: MaterialFile[],
): Record<string, string> {
  return Object.fromEntries(
    packageIds.map((packageId) => {
      const packageItem = packages.find((item) => item.id === packageId)
      return [packageId, packageItem ? packageFingerprint(packageItem, files) : 'missing']
    }),
  )
}

/** 建批校验：收件方、目的地、最终用途必须一致，且每份资料包都能匹配许可规则。 */
export function validateBatchComposition(
  members: MaterialPackage[],
  rules: WorkspaceState['rules'],
): string[] {
  const errors: string[] = []
  if (members.length < 2) {
    errors.push('联合许可批次至少包含 2 份资料包。')
    return errors
  }
  const [first, ...rest] = members
  if (rest.some((item) => item.recipient !== first.recipient)) {
    errors.push(
      `收件方不一致：${members.map((item) => `${item.code}（${item.recipient}）`).join('、')}。`,
    )
  }
  if (rest.some((item) => item.destination !== first.destination)) {
    errors.push(`目的地不一致：批次内必须同为「${first.destination}」。`)
  }
  if (rest.some((item) => item.endUse !== first.endUse)) {
    errors.push('最终用途不一致：同一出口批次不允许拼装不同最终用途的资料包。')
  }
  members.forEach((item) => {
    if (!findApplicableRule(item, rules)) {
      errors.push(`${item.code} 未匹配到许可规则，不能加入联合批次。`)
    }
  })
  return errors
}

export function findActiveBatchForPackage(
  batches: LicenseBatch[],
  packageId: string,
): LicenseBatch | undefined {
  return batches.find(
    (batch) => isBatchActive(batch) && batch.items.some((item) => item.packageId === packageId),
  )
}

/**
 * 任一资料包换版或内容变化时，整批预占立即失效并转待复核。
 * 已通过的审批步骤和已产生的许可（核销）记录不受影响。
 */
export function invalidateBatchesForPackage(
  state: WorkspaceState,
  packageId: string,
  changeDescription: string,
  timestamp: string,
): LicenseBatch[] {
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (!packageItem) return []
  const invalidated: LicenseBatch[] = []
  state.batches.forEach((batch) => {
    if (batch.status !== 'reserved') return
    if (!batch.items.some((item) => item.packageId === packageId)) return
    const nextFingerprint = packageFingerprint(packageItem, state.files)
    if (batch.fingerprints[packageId] === nextFingerprint) return
    batch.status = 'pending-review'
    batch.invalidReason = `${packageItem.code} ${changeDescription}，整批预占失效，待复核后重新预占。`
    batch.updatedAt = timestamp
    invalidated.push(batch)
  })
  return invalidated
}
