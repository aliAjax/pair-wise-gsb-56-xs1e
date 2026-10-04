import type {
  BatchReservationItem,
  LicenseBatch,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  WorkspaceState,
} from '@/types/domain'
import { findApplicableRule } from './rules'

export const batchStatusLabels: Record<LicenseBatch['status'], string> = {
  reserved: '预占生效',
  'pending-review': '待核',
  settled: '已核销',
}

export function batchIdempotencyKey(packageIds: string[]): string {
  return [...packageIds].sort().join('+')
}

/**
 * 资料包内容指纹：申报要素、资料包版本链和文件现行/引用版本共同决定。
 * 审批步骤、额度占用不属于内容，不会触发批次失效。
 */
export function computePackageFingerprint(
  packageItem: MaterialPackage,
  files: MaterialFile[],
): string {
  const filePart = files
    .filter((file) => file.packageId === packageItem.id)
    .map((file) => {
      const active = file.versions.find((version) => version.id === file.activeVersionId)
      const pageSignature = active
        ? active.pages
            .map(
              (page) =>
                `${page.controlled ? 1 : 0}${page.desensitized ? 1 : 0}${page.reviewedAt ? 1 : 0}`,
            )
            .join('')
        : ''
      return `${file.id}:${file.activeVersionId}:${file.referencedVersionId}:${active?.hash ?? ''}:${pageSignature}`
    })
    .sort()
    .join('|')
  const lastVersion = packageItem.versions.at(-1)
  return [
    packageItem.id,
    packageItem.title,
    packageItem.category,
    packageItem.recipient,
    packageItem.destination,
    packageItem.endUse,
    [...packageItem.technologyTags].sort().join(','),
    [...packageItem.personnelScopes].sort().join(','),
    [...packageItem.declarations].sort().join(','),
    `${packageItem.versions.length}:${lastVersion?.id ?? ''}`,
    filePart,
  ].join('#')
}

export function computeBatchFingerprint(
  packages: MaterialPackage[],
  files: MaterialFile[],
): string {
  return packages.map((item) => computePackageFingerprint(item, files)).join('##')
}

/** 建批校验：收件方、目的地、最终用途必须一致，且每份资料包都能匹配许可规则。 */
export function validateBatchComposition(
  packages: MaterialPackage[],
  rules: LicenseRule[],
): string[] {
  const problems: string[] = []
  if (packages.length < 2) {
    problems.push('联合许可批次至少需要 2 份资料包。')
  }
  if (new Set(packages.map((item) => item.recipient)).size > 1) {
    problems.push('资料包收件方不一致，不能并入同一出口批次。')
  }
  if (new Set(packages.map((item) => item.destination)).size > 1) {
    problems.push('资料包目的地不一致，不能并入同一出口批次。')
  }
  if (new Set(packages.map((item) => item.endUse)).size > 1) {
    problems.push('资料包最终用途不一致，不能并入同一出口批次。')
  }
  packages.forEach((item) => {
    if (!findApplicableRule(item, rules)) {
      problems.push(`${item.code} 未匹配到许可规则，不能加入批次。`)
    }
  })
  return problems
}

/** 规则维度剩余额度：规则上限减去全 workspace 已扣减和其他生效批次的预占。 */
export function ruleRemainingQuota(
  rule: LicenseRule,
  allPackages: MaterialPackage[],
  batches: LicenseBatch[],
  excludeBatchId?: string,
): number {
  const consumed = allPackages
    .filter((item) => item.matchedRuleId === rule.id)
    .reduce((sum, item) => sum + item.quotaUsed, 0)
  const reserved = batches
    .filter((batch) => batch.status === 'reserved' && batch.id !== excludeBatchId)
    .flatMap((batch) => batch.reservations)
    .filter((item) => item.ruleId === rule.id)
    .reduce((sum, item) => sum + item.amount, 0)
  return rule.quotaLimit - consumed - reserved
}

export interface ReservationPlan {
  items: BatchReservationItem[]
  problems: string[]
}

/** 按规则汇总预占需求，逐包核对剩余额度、按规则核对总额度。 */
export function planBatchReservations(
  members: MaterialPackage[],
  rules: LicenseRule[],
  amounts: Record<string, number>,
  allPackages: MaterialPackage[],
  batches: LicenseBatch[],
  excludeBatchId?: string,
): ReservationPlan {
  const items: BatchReservationItem[] = []
  const problems: string[] = []
  const ruleDemand = new Map<string, number>()

  members.forEach((item) => {
    const rule = findApplicableRule(item, rules)
    if (!rule) return
    const amount = Math.trunc(amounts[item.id] ?? 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      problems.push(`${item.code} 预占额度必须大于 0。`)
      return
    }
    const packageRemaining = item.quotaLimit - item.quotaUsed
    if (amount > packageRemaining) {
      problems.push(`${item.code} 剩余额度 ${packageRemaining}，不足以预占 ${amount}。`)
    }
    ruleDemand.set(rule.id, (ruleDemand.get(rule.id) ?? 0) + amount)
    items.push({
      packageId: item.id,
      packageCode: item.code,
      ruleId: rule.id,
      ruleName: rule.name,
      amount,
    })
  })

  ruleDemand.forEach((demand, ruleId) => {
    const rule = rules.find((item) => item.id === ruleId)
    if (!rule) return
    const remaining = ruleRemainingQuota(rule, allPackages, batches, excludeBatchId)
    if (demand > remaining) {
      problems.push(`规则「${rule.name}」剩余可用额度 ${remaining}，不足以整批预占 ${demand}。`)
    }
  })

  return { items, problems }
}

/**
 * 失效扫描：任一成员资料包换版或内容变化，整批预占立即失效转待核。
 * 只改批次状态，资料包的审批步骤和许可记录保持原样。
 */
export function refreshBatchStates(state: WorkspaceState): LicenseBatch[] {
  const invalidated: LicenseBatch[] = []
  state.batches.forEach((batch) => {
    if (batch.status !== 'reserved') return
    const members = batch.packageIds.map((id) =>
      state.packages.find((item) => item.id === id),
    )
    if (members.some((item) => !item)) {
      batch.status = 'pending-review'
      batch.statusReason = '批次成员资料包已不存在，整批预占失效转待核。'
      batch.updatedAt = new Date().toISOString()
      invalidated.push(batch)
      return
    }
    const fingerprint = computeBatchFingerprint(members as MaterialPackage[], state.files)
    if (fingerprint !== batch.fingerprint) {
      batch.status = 'pending-review'
      batch.statusReason =
        '成员资料包换版或内容变化，整批预占失效转待核；已通过步骤和许可记录保留。'
      batch.updatedAt = new Date().toISOString()
      invalidated.push(batch)
    }
  })
  return invalidated
}
