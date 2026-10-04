import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  LicenseBatch,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  batchIdempotencyKey,
  computeBatchFingerprint,
  planBatchReservations,
  refreshBatchStates,
  ruleRemainingQuota,
  validateBatchComposition,
} from '@/services/batches'

export interface BatchMutationResult {
  state: WorkspaceState
  batch: LicenseBatch
  deduplicated: boolean
  message?: string
}

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  body,
}) => {
  await wait()
  let state = loadWorkspace()
  const payload = (body ?? {}) as Record<string, unknown>
  let result: unknown
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }

  // 失效扫描：成员资料包换版或内容变化时，整批预占立即失效转待核。
  // 请求处理前后各执行一次，保证变更类请求的响应本身即反映失效结果。
  const scanBatches = () => {
    const invalidated = refreshBatchStates(state)
    invalidated.forEach((batch) =>
      audit({
        action: '批次预占失效',
        target: batch.code,
        operator: '系统',
        detail: batch.statusReason,
      }),
    )
    return invalidated.length > 0
  }
  if (scanBatches()) saveWorkspace(state)

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
      const packageIds = (payload.packageIds as string[]).map(String)
      const amounts = (payload.amounts ?? {}) as Record<string, number>
      const members = packageIds.map((id) => state.packages.find((item) => item.id === id))
      if (members.some((item) => !item)) throw new Error('存在无效的资料包选择')
      const memberList = members as MaterialPackage[]
      const key = batchIdempotencyKey(packageIds)
      const existing = state.batches.find((batch) => batch.idempotencyKey === key)
      if (existing) {
        // 两个窗口同时提交同一批次：只成功一次，失败方读取现有批次。
        audit({
          action: '重复提交拦截',
          target: existing.code,
          operator: '当前用户',
          detail: '同一批次已在其他窗口提交，本次读取现有批次，未重复建批。',
        })
        result = { state, batch: existing, deduplicated: true }
      } else {
        const problems = validateBatchComposition(memberList, state.rules)
        if (problems.length) throw new Error(problems.join('；'))
        const plan = planBatchReservations(
          memberList,
          state.rules,
          amounts,
          state.packages,
          state.batches,
        )
        if (plan.problems.length) throw new Error(plan.problems.join('；'))
        const batch: LicenseBatch = {
          id: `batch-${crypto.randomUUID()}`,
          code: `LB-2026-${String(state.batches.length + 1).padStart(3, '0')}`,
          idempotencyKey: key,
          recipient: memberList[0].recipient,
          destination: memberList[0].destination,
          endUse: memberList[0].endUse,
          packageIds: memberList.map((item) => item.id),
          reservations: plan.items,
          totalReserved: plan.items.reduce((sum, item) => sum + item.amount, 0),
          fingerprint: computeBatchFingerprint(memberList, state.files),
          status: 'reserved',
          statusReason: '',
          deductions: [],
          createdAt: now(),
          updatedAt: now(),
          createdBy: '当前用户',
        }
        state.batches.unshift(batch)
        audit({
          action: '创建联合许可批次',
          target: batch.code,
          operator: '当前用户',
          detail: `合并 ${batch.packageIds.length} 份资料包，按规则预占总额度 ${batch.totalReserved}。`,
        })
        result = { state, batch, deduplicated: false }
      }
    } else if (url === '/batch/settle') {
      const batch = state.batches.find((item) => item.id === String(payload.batchId))
      if (!batch) throw new Error('许可批次不存在')
      if (batch.status === 'settled') {
        // 重复核销不重复扣。
        result = { state, batch, deduplicated: true, message: '批次已核销，本次未重复扣减。' }
      } else if (batch.status === 'pending-review') {
        throw new Error('批次预占已失效并转待核，请重新校验预占后再核销。')
      } else {
        const problems: string[] = []
        batch.reservations.forEach((item) => {
          const packageItem = state.packages.find((entry) => entry.id === item.packageId)
          if (!packageItem) {
            problems.push(`${item.packageCode} 已不存在。`)
            return
          }
          if (batch.deductions.some((entry) => entry.packageId === item.packageId)) return
          if (packageItem.status !== 'approved' && packageItem.status !== 'licensed') {
            problems.push(`${packageItem.code} 审批未完成，不能核销扣减。`)
          }
          if (packageItem.quotaUsed + item.amount > packageItem.quotaLimit) {
            problems.push(
              `${packageItem.code} 剩余额度 ${packageItem.quotaLimit - packageItem.quotaUsed}，不足以扣减 ${item.amount}。`,
            )
          }
        })
        const ruleDemand = new Map<string, number>()
        batch.reservations.forEach((item) => {
          ruleDemand.set(item.ruleId, (ruleDemand.get(item.ruleId) ?? 0) + item.amount)
        })
        ruleDemand.forEach((demand, ruleId) => {
          const rule = state.rules.find((item) => item.id === ruleId)
          if (!rule) return
          const remaining = ruleRemainingQuota(rule, state.packages, state.batches, batch.id)
          if (demand > remaining) {
            problems.push(`规则「${rule.name}」剩余可用额度 ${remaining}，不足以整批扣减 ${demand}。`)
          }
        })
        if (problems.length) {
          // 扣减失败：整批预占保留，记录失败原因后可重试。
          audit({
            action: '批次核销失败',
            target: batch.code,
            operator: '当前用户',
            detail: `${problems.join('；')} 整批预占保留，可修复后重试。`,
          })
          saveWorkspace(state)
          throw new Error(`${problems.join('；')}。整批预占保留，可重试。`)
        }
        batch.reservations.forEach((item) => {
          if (batch.deductions.some((entry) => entry.packageId === item.packageId)) return
          const packageItem = state.packages.find((entry) => entry.id === item.packageId)
          if (!packageItem) return
          packageItem.quotaUsed += item.amount
          packageItem.status = 'licensed'
          packageItem.updatedAt = now()
          batch.deductions.push({
            packageId: packageItem.id,
            packageCode: packageItem.code,
            amount: item.amount,
            deductedAt: now(),
          })
        })
        batch.status = 'settled'
        batch.settledAt = now()
        batch.updatedAt = now()
        batch.statusReason = ''
        audit({
          action: '核销联合许可批次',
          target: batch.code,
          operator: '当前用户',
          detail: `核销 ${batch.deductions.length} 份资料包，共扣减 ${batch.totalReserved} 额度。`,
        })
        result = { state, batch, deduplicated: false }
      }
    } else if (url === '/batch/recheck') {
      const batch = state.batches.find((item) => item.id === String(payload.batchId))
      if (!batch) throw new Error('许可批次不存在')
      if (batch.status === 'settled') throw new Error('批次已核销，无需重新校验。')
      const members = batch.packageIds.map((id) => state.packages.find((item) => item.id === id))
      if (members.some((item) => !item)) throw new Error('批次成员资料包已不存在，无法重新校验。')
      const memberList = members as MaterialPackage[]
      const problems = validateBatchComposition(memberList, state.rules)
      const amounts = Object.fromEntries(
        batch.reservations.map((item) => [item.packageId, item.amount]),
      )
      const plan = planBatchReservations(
        memberList,
        state.rules,
        amounts,
        state.packages,
        state.batches,
        batch.id,
      )
      problems.push(...plan.problems)
      if (problems.length) {
        batch.status = 'pending-review'
        batch.statusReason = problems.join('；')
        batch.updatedAt = now()
        saveWorkspace(state)
        throw new Error(problems.join('；'))
      }
      batch.reservations = plan.items
      batch.totalReserved = plan.items.reduce((sum, item) => sum + item.amount, 0)
      batch.fingerprint = computeBatchFingerprint(memberList, state.files)
      batch.status = 'reserved'
      batch.statusReason = ''
      batch.updatedAt = now()
      audit({
        action: '重新校验批次预占',
        target: batch.code,
        operator: '当前用户',
        detail: `校验通过，整批预占恢复生效，预占总额度 ${batch.totalReserved}。`,
      })
      result = { state, batch, deduplicated: false }
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

    scanBatches()
    saveWorkspace(state)
    return { data: result ?? state }
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
    createBatch: builder.mutation<
      BatchMutationResult,
      { packageIds: string[]; amounts: Record<string, number> }
    >({
      query: (body) => ({ url: '/batch/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    settleBatch: builder.mutation<BatchMutationResult, { batchId: string }>({
      query: (body) => ({ url: '/batch/settle', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    recheckBatch: builder.mutation<BatchMutationResult, { batchId: string }>({
      query: (body) => ({ url: '/batch/recheck', method: 'POST', body }),
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
  useCreateBatchMutation,
  useSettleBatchMutation,
  useRecheckBatchMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
