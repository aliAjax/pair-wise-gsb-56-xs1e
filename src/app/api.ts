import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  LicenseBatch,
  LicenseBatchItem,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  batchFingerprints,
  findActiveBatchForPackage,
  invalidateBatchesForPackage,
  validateBatchComposition,
} from '@/services/batch'
import { packageStatusLabels } from '@/services/mockData'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

export interface BatchCreateResult {
  state: WorkspaceState
  batch: LicenseBatch
  deduplicated: boolean
}

export interface BatchDeductResult {
  state: WorkspaceState
  batch: LicenseBatch
  idempotent: boolean
}

export interface BatchRevalidateResult {
  state: WorkspaceState
  batch: LicenseBatch
}

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  body,
}) => {
  await wait()
  let state = loadWorkspace()
  const payload = (body ?? {}) as Record<string, unknown>
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }
  // 任一资料包换版或内容变化 → 所在批次整批预占失效并转待复核（已通过步骤和许可记录保留）
  const invalidateBatches = (packageId: string, changeDescription: string) => {
    invalidateBatchesForPackage(state, packageId, changeDescription, now()).forEach((batch) => {
      audit({
        packageId,
        action: '批次预占失效',
        target: batch.code,
        operator: '系统',
        detail: batch.invalidReason ?? '资料包内容变化，整批预占失效。',
      })
    })
  }

  try {
    if (url === '/workspace') return { data: state }

    if (url === '/package/save') {
      const packageId = String(payload.packageId)
      const patch = payload.patch as Partial<MaterialPackage>
      const current = state.packages.find((item) => item.id === packageId)
      if (!current) throw new Error('资料包不存在')
      Object.assign(current, patch, { updatedAt: now() })
      current.matchedRuleId = findApplicableRule(current, state.rules)?.id
      audit({
        packageId,
        action: '更新资料包',
        target: current.code,
        operator: '当前用户',
        detail: '更新收件方、最终用途、声明或技术参数。',
      })
      invalidateBatches(packageId, '申报内容变化')
    } else if (url === '/package/create') {
      const draft = payload.package as Omit<
        MaterialPackage,
        'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
      >
      const rule = findApplicableRule(
        { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
        state.rules,
      )
      const packageItem: MaterialPackage = {
        ...draft,
        id: `pkg-${crypto.randomUUID()}`,
        matchedRuleId: rule?.id,
        approvalRoute: [],
        currentRound: 0,
        createdAt: now(),
        updatedAt: now(),
        versions: [],
      }
      packageItem.versions.push({
        id: `version-${crypto.randomUUID()}`,
        label: 'V1.0',
        createdAt: now(),
        createdBy: packageItem.applicant,
        summary: '创建资料包初始版本。',
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: {},
        },
      })
      state.packages.unshift(packageItem)
      audit({
        packageId: packageItem.id,
        action: '创建资料包',
        target: packageItem.code,
        operator: packageItem.applicant,
        detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
      })
    } else if (url === '/file/save') {
      const file = payload.file as MaterialFile
      const index = state.files.findIndex((item) => item.id === file.id)
      if (index >= 0) state.files[index] = file
      else state.files.push(file)
      invalidateBatches(file.packageId, '文件信息变化')
    } else if (url === '/file/version/add') {
      const packageId = String(payload.packageId)
      const fileId = String(payload.fileId)
      const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
      if (!file) throw new Error('文件不存在')
      const pageCount = Number(payload.pageCount)
      const label = String(payload.label)
      const summary = String(payload.summary)
      const newVersion = {
        id: `file-version-${crypto.randomUUID()}`,
        label,
        uploadedAt: now(),
        hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
        sizeKb: pageCount * 96 + 720,
        pages: Array.from({ length: pageCount }, (_, index) => ({
          id: `page-${crypto.randomUUID()}`,
          page: index + 1,
          category: file.kind,
          controlled: false,
          desensitized: false,
          note: '',
          reviewer: '',
        })),
        changeSummary: summary,
      }
      file.versions.push(newVersion)
      file.activeVersionId = newVersion.id
      audit({
        packageId,
        action: '上传文件版本',
        target: `${file.name} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
      invalidateBatches(packageId, `文件 ${file.name} 换版为 ${label}`)
    } else if (url === '/file/reference') {
      const fileId = String(payload.fileId)
      const versionId = String(payload.versionId)
      const file = state.files.find((item) => item.id === fileId)
      if (!file) throw new Error('文件不存在')
      file.referencedVersionId = versionId
      audit({
        packageId: file.packageId,
        action: '选择引用版本',
        target: file.name,
        operator: '当前用户',
        detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
      })
      invalidateBatches(file.packageId, `文件 ${file.name} 引用版本调整`)
    } else if (url === '/page/save') {
      const file = state.files.find((item) => item.id === String(payload.fileId))
      const version = file?.versions.find((item) => item.id === String(payload.versionId))
      if (!file || !version) throw new Error('文件版本不存在')
      const page = payload.page as PageReview
      const index = version.pages.findIndex((item) => item.id === page.id)
      if (index >= 0) version.pages[index] = page
      else version.pages.push(page)
      audit({
        packageId: file.packageId,
        action: '逐页分类核对',
        target: `${file.name} 第 ${page.page} 页`,
        operator: page.reviewer || '当前用户',
        detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
      })
      invalidateBatches(file.packageId, `文件 ${file.name} 逐页核对结果变化`)
    } else if (url === '/package/validate') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      state.findings = [
        ...state.findings.filter((item) => item.packageId !== packageId),
        ...validatePackage(packageItem, state.files, state.rules),
      ]
      audit({
        packageId,
        action: '执行许可校验',
        target: packageItem.code,
        operator: '当前用户',
        detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果。`,
      })
    } else if (url === '/package/version') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const summary = String(payload.summary)
      const label = String(payload.label)
      packageItem.versions.push({
        id: `package-version-${crypto.randomUUID()}`,
        label,
        createdAt: now(),
        createdBy: '当前用户',
        summary,
        snapshot: {
          title: packageItem.title,
          category: packageItem.category,
          destination: packageItem.destination,
          endUse: packageItem.endUse,
          technologyTags: [...packageItem.technologyTags],
          personnelScopes: [...packageItem.personnelScopes],
          declarations: [...packageItem.declarations],
          activeFileVersions: Object.fromEntries(
            state.files
              .filter((file) => file.packageId === packageId)
              .map((file) => [file.id, file.activeVersionId]),
          ),
        },
      })
      audit({
        packageId,
        action: '创建资料包版本',
        target: `${packageItem.code} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
      invalidateBatches(packageId, `资料包换版为 ${label}`)
    } else if (url === '/approval/submit') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const rule = findApplicableRule(packageItem, state.rules)
      if (!rule) throw new Error('未匹配到许可规则')
      packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
      packageItem.matchedRuleId = rule.id
      packageItem.status = 'reviewing'
      packageItem.currentRound += 1
      audit({
        packageId,
        action: '提交审批',
        target: packageItem.code,
        operator: '当前用户',
        detail: `按 ${rule.name} 生成审批路线，第 ${packageItem.currentRound} 轮。`,
      })
    } else if (url === '/approval/decide') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
      if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
      const decision = String(payload.decision)
      step.comment = String(payload.comment ?? '')
      step.decidedAt = now()
      if (decision === 'return') {
        step.status = 'returned'
        packageItem.status = 'returned'
      } else {
        step.status = 'approved'
        const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
        if (next) next.status = 'active'
        else packageItem.status = 'approved'
      }
      audit({
        packageId,
        action: decision === 'return' ? '审批退回' : '审批通过',
        target: `${packageItem.code} / ${step.role}`,
        operator: step.assignee,
        detail: step.comment || '无补充意见。',
      })
    } else if (url === '/license/deduct') {
      const packageId = String(payload.packageId)
      const amount = Number(payload.amount)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const blockingBatch = findActiveBatchForPackage(state.batches, packageId)
      if (blockingBatch) {
        throw new Error(
          `该资料包已加入联合许可批次 ${blockingBatch.code}，请按批次统一核销，避免拆散出口批次。`,
        )
      }
      if (packageItem.quotaUsed + amount > packageItem.quotaLimit) {
        throw new Error('许可额度不足')
      }
      packageItem.quotaUsed += amount
      packageItem.status = 'licensed'
      audit({
        packageId,
        action: '扣减许可额度',
        target: packageItem.code,
        operator: '当前用户',
        detail: `扣减 ${amount}，剩余 ${packageItem.quotaLimit - packageItem.quotaUsed}。`,
      })
    } else if (url === '/batch/create') {
      // 并发建批：以最新持久化状态做幂等判定，同一幂等键只成功一次，失败方读取现有批次
      state = loadWorkspace()
      const packageIds = (payload.packageIds as string[]).map(String)
      const amounts = (payload.amounts ?? {}) as Record<string, number>
      const idempotencyKey = String(payload.idempotencyKey)
      const existing = state.batches.find((batch) => batch.idempotencyKey === idempotencyKey)
      if (existing) {
        return { data: { state, batch: existing, deduplicated: true } satisfies BatchCreateResult }
      }
      const members = packageIds.map((id) =>
        state.packages.find((item) => item.id === id),
      ) as MaterialPackage[]
      if (members.some((item) => !item)) throw new Error('资料包不存在')
      const compositionErrors = validateBatchComposition(members, state.rules)
      if (compositionErrors.length) throw new Error(compositionErrors.join('；'))
      members.forEach((item) => {
        const blocking = findActiveBatchForPackage(state.batches, item.id)
        if (blocking) {
          throw new Error(`${item.code} 已在活动批次 ${blocking.code} 中，不能重复入批。`)
        }
        const amount = Number(amounts[item.id])
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error(`${item.code} 的预占额度必须大于 0。`)
        }
        if (item.quotaUsed + amount > item.quotaLimit) {
          throw new Error(
            `${item.code} 预占 ${amount} 后超出许可额度上限（已用 ${item.quotaUsed}，上限 ${item.quotaLimit}）。`,
          )
        }
      })
      const first = members[0]
      const items: LicenseBatchItem[] = members.map((item) => {
        const rule = findApplicableRule(item, state.rules)
        return {
          packageId: item.id,
          ruleId: rule?.id ?? '',
          ruleName: rule?.name ?? '未匹配规则',
          amount: Number(amounts[item.id]),
          deducted: false,
        }
      })
      const batch: LicenseBatch = {
        id: `batch-${crypto.randomUUID()}`,
        code: `LB-2026-${String(state.batches.length + 1).padStart(3, '0')}`,
        idempotencyKey,
        recipient: first.recipient,
        destination: first.destination,
        endUse: first.endUse,
        items,
        totalReserved: items.reduce((sum, item) => sum + item.amount, 0),
        status: 'reserved',
        fingerprints: batchFingerprints(packageIds, state.packages, state.files),
        createdBy: String(payload.createdBy ?? '当前用户'),
        createdAt: now(),
        updatedAt: now(),
      }
      state.batches.unshift(batch)
      audit({
        action: '创建联合许可批次',
        target: batch.code,
        operator: batch.createdBy,
        detail: `收件方 ${batch.recipient}，目的地 ${batch.destination}，${items.length} 份资料包按规则预占总额度 ${batch.totalReserved}。`,
      })
      saveWorkspace(state)
      return { data: { state, batch, deduplicated: false } satisfies BatchCreateResult }
    } else if (url === '/batch/deduct') {
      const batchId = String(payload.batchId)
      const batch = state.batches.find((item) => item.id === batchId)
      if (!batch) throw new Error('联合许可批次不存在')
      if (batch.status === 'licensed') {
        // 重复核销：幂等返回，不重复扣减
        return { data: { state, batch, idempotent: true } satisfies BatchDeductResult }
      }
      if (batch.status === 'pending-review') {
        throw new Error(
          `批次预占已失效（${batch.invalidReason ?? '待复核'}），请先重新校验恢复预占。`,
        )
      }
      // 整批核销前置校验：任一资料包不满足则整批不扣，预占保留可重试
      const blockers: string[] = []
      batch.items.forEach((item) => {
        if (item.deducted) return
        const packageItem = state.packages.find((entry) => entry.id === item.packageId)
        if (!packageItem) {
          blockers.push(`${item.packageId} 资料包不存在`)
          return
        }
        if (packageItem.status !== 'approved' && packageItem.status !== 'licensed') {
          blockers.push(
            `${packageItem.code} 尚未完成审批（当前：${packageStatusLabels[packageItem.status]}）`,
          )
        }
        if (packageItem.quotaUsed + item.amount > packageItem.quotaLimit) {
          blockers.push(
            `${packageItem.code} 许可额度不足：已用 ${packageItem.quotaUsed}，需扣 ${item.amount}，上限 ${packageItem.quotaLimit}`,
          )
        }
      })
      if (blockers.length) {
        batch.lastDeductError = blockers.join('；')
        batch.updatedAt = now()
        audit({
          action: '批次核销失败',
          target: batch.code,
          operator: '当前用户',
          detail: `${batch.lastDeductError}。整批预占保留，可修复后重试。`,
        })
        saveWorkspace(state)
        throw new Error(`核销失败，整批预占保留：${batch.lastDeductError}`)
      }
      batch.items.forEach((item) => {
        if (item.deducted) return
        const packageItem = state.packages.find((entry) => entry.id === item.packageId)
        if (!packageItem) return
        packageItem.quotaUsed += item.amount
        packageItem.status = 'licensed'
        packageItem.updatedAt = now()
        item.deducted = true
        item.deductedAt = now()
      })
      batch.status = 'licensed'
      batch.lastDeductError = undefined
      batch.updatedAt = now()
      audit({
        action: '批次核销扣减',
        target: batch.code,
        operator: '当前用户',
        detail: `整批核销 ${batch.items.length} 份资料包，合计扣减许可额度 ${batch.totalReserved}，出口批次不再拆散。`,
      })
      saveWorkspace(state)
      return { data: { state, batch, idempotent: false } satisfies BatchDeductResult }
    } else if (url === '/batch/revalidate') {
      const batchId = String(payload.batchId)
      const batch = state.batches.find((item) => item.id === batchId)
      if (!batch) throw new Error('联合许可批次不存在')
      if (batch.status === 'licensed') throw new Error('批次已核销，无需重新校验。')
      if (batch.status === 'reserved') {
        return { data: { state, batch } satisfies BatchRevalidateResult }
      }
      const members = batch.items.map((item) =>
        state.packages.find((entry) => entry.id === item.packageId),
      ) as MaterialPackage[]
      if (members.some((item) => !item)) throw new Error('批次内资料包已被删除，无法恢复预占。')
      const errors = validateBatchComposition(members, state.rules)
      members.forEach((item) => {
        if (
          item.recipient !== batch.recipient ||
          item.destination !== batch.destination ||
          item.endUse !== batch.endUse
        ) {
          errors.push(`${item.code} 的收件方、目的地或最终用途已偏离批次记录，请撤销变更后复核。`)
        }
      })
      batch.items.forEach((item) => {
        const packageItem = members.find((entry) => entry.id === item.packageId)
        if (packageItem && !item.deducted && packageItem.quotaUsed + item.amount > packageItem.quotaLimit) {
          errors.push(
            `${packageItem.code} 额度不足：已用 ${packageItem.quotaUsed}，预占 ${item.amount}，上限 ${packageItem.quotaLimit}。`,
          )
        }
      })
      if (errors.length) throw new Error(errors.join('；'))
      batch.fingerprints = batchFingerprints(
        batch.items.map((item) => item.packageId),
        state.packages,
        state.files,
      )
      batch.status = 'reserved'
      batch.invalidReason = undefined
      batch.updatedAt = now()
      audit({
        action: '批次复核恢复预占',
        target: batch.code,
        operator: '当前用户',
        detail: `换版或内容变化已复核，整批预占 ${batch.totalReserved} 恢复有效。`,
      })
      saveWorkspace(state)
      return { data: { state, batch } satisfies BatchRevalidateResult }
    } else if (url === '/comment/add') {
      state.comments.unshift({
        ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
        id: `comment-${crypto.randomUUID()}`,
        createdAt: now(),
      })
    } else if (url === '/audit/add') {
      audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
    } else if (url === '/workspace/reset') {
      state = resetWorkspace()
      return { data: state }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    saveWorkspace(state)
    return { data: state }
  } catch (error) {
    return {
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
      },
    }
  }
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductQuota: builder.mutation<WorkspaceState, { packageId: string; amount: number }>({
      query: (body) => ({ url: '/license/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createLicenseBatch: builder.mutation<
      BatchCreateResult,
      {
        packageIds: string[]
        amounts: Record<string, number>
        idempotencyKey: string
        createdBy?: string
      }
    >({
      query: (body) => ({ url: '/batch/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    deductLicenseBatch: builder.mutation<BatchDeductResult, { batchId: string }>({
      query: (body) => ({ url: '/batch/deduct', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    revalidateLicenseBatch: builder.mutation<BatchRevalidateResult, { batchId: string }>({
      query: (body) => ({ url: '/batch/revalidate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useDecideApprovalMutation,
  useDeductQuotaMutation,
  useCreateLicenseBatchMutation,
  useDeductLicenseBatchMutation,
  useRevalidateLicenseBatchMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
