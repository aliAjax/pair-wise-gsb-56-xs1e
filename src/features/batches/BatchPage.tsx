import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { PartitionOutlined } from '@ant-design/icons'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import {
  useCreateBatchMutation,
  useGetWorkspaceQuery,
  useRecheckBatchMutation,
  useSettleBatchMutation,
} from '@/app/api'
import type { BatchReservationItem, LicenseBatch, MaterialPackage } from '@/types/domain'
import {
  batchStatusLabels,
  planBatchReservations,
  validateBatchComposition,
} from '@/services/batches'

const batchStatusColors: Record<LicenseBatch['status'], string> = {
  reserved: 'processing',
  'pending-review': 'warning',
  settled: 'success',
}

function errorDetail(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error) {
    if ('data' in error) {
      const data = (error as { data?: { error?: string } }).data
      if (data?.error) return data.error
    }
    if ('error' in error) {
      const detail = (error as { error?: unknown }).error
      if (typeof detail === 'string') return detail
    }
  }
  return fallback
}

export function BatchPage() {
  const { data, isLoading } = useGetWorkspaceQuery()
  const [createBatch, createState] = useCreateBatchMutation()
  const [settleBatch, settleState] = useSettleBatchMutation()
  const [recheckBatch, recheckState] = useRecheckBatchMutation()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [amounts, setAmounts] = useState<Record<string, number>>({})
  const [activeBatchId, setActiveBatchId] = useState('')

  useEffect(() => {
    if (!activeBatchId && data?.batches[0]) setActiveBatchId(data.batches[0].id)
  }, [data, activeBatchId])

  const members = useMemo(
    () =>
      selectedIds
        .map((id) => data?.packages.find((item) => item.id === id))
        .filter((item): item is MaterialPackage => Boolean(item)),
    [data, selectedIds],
  )

  const compositionProblems = useMemo(
    () => (data && members.length ? validateBatchComposition(members, data.rules) : []),
    [data, members],
  )
  const plan = useMemo(
    () =>
      data && members.length >= 2 && !compositionProblems.length
        ? planBatchReservations(members, data.rules, amounts, data.packages, data.batches)
        : undefined,
    [data, members, amounts, compositionProblems.length],
  )
  const createProblems = [...compositionProblems, ...(plan?.problems ?? [])]

  const activeBatch = useMemo(
    () => data?.batches.find((item) => item.id === activeBatchId),
    [data, activeBatchId],
  )
  const activeMembers = useMemo(
    () =>
      (activeBatch?.packageIds ?? [])
        .map((id) => data?.packages.find((item) => item.id === id))
        .filter((item): item is MaterialPackage => Boolean(item)),
    [data, activeBatch],
  )

  if (isLoading || !data) return <div className="panel">正在加载联合许可批次...</div>

  const batchColumns: TableColumnsType<LicenseBatch> = [
    { title: '批次号', dataIndex: 'code', width: 130 },
    { title: '收件方', dataIndex: 'recipient', minWidth: 220 },
    { title: '目的地', dataIndex: 'destination', width: 100 },
    {
      title: '资料包',
      dataIndex: 'packageIds',
      width: 90,
      render: (value: string[]) => `${value.length} 份`,
    },
    {
      title: '预占总额度',
      dataIndex: 'totalReserved',
      width: 110,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: LicenseBatch['status']) => (
        <Tag color={batchStatusColors[value]}>{batchStatusLabels[value]}</Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 165,
      render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false }),
    },
  ]

  const reservationColumns: TableColumnsType<BatchReservationItem> = [
    { title: '资料包', dataIndex: 'packageCode', width: 130 },
    { title: '许可规则', dataIndex: 'ruleName', minWidth: 220 },
    { title: '预占额度', dataIndex: 'amount', width: 100 },
  ]

  const memberColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 125 },
    { title: '资料包', dataIndex: 'title', minWidth: 180 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 95,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '额度',
      width: 120,
      render: (_, record) => `${record.quotaUsed} / ${record.quotaLimit}`,
    },
  ]

  async function submitCreate() {
    try {
      const result = await createBatch({ packageIds: selectedIds, amounts }).unwrap()
      setActiveBatchId(result.batch.id)
      if (result.deduplicated) {
        message.warning(`同一批次已存在（可能由另一窗口提交），已读取现有批次 ${result.batch.code}`)
      } else {
        message.success(`联合批次 ${result.batch.code} 已创建，整批预占 ${result.batch.totalReserved} 额度`)
      }
      setSelectedIds([])
      setAmounts({})
    } catch (error) {
      message.error(errorDetail(error, '创建联合批次失败'))
    }
  }

  async function settle(batchId: string) {
    try {
      const result = await settleBatch({ batchId }).unwrap()
      if (result.deduplicated) {
        message.info(result.message ?? '批次已核销，未重复扣减')
      } else {
        message.success(`批次 ${result.batch.code} 核销完成，整批扣减 ${result.batch.totalReserved} 额度`)
      }
    } catch (error) {
      message.error(errorDetail(error, '批次核销失败'))
    }
  }

  async function recheck(batchId: string) {
    try {
      await recheckBatch({ batchId }).unwrap()
      message.success('重新校验通过，整批预占已恢复生效')
    } catch (error) {
      message.error(errorDetail(error, '重新校验未通过'))
    }
  }

  return (
    <div>
      <PageHeader
        title="联合许可批次"
        description="同一收件方的多份资料包合并建批：校验收件方、目的地和最终用途，按规则预占总额度；任一成员换版或内容变化，整批预占立即失效转待核。"
      />

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>创建联合批次</h3>
            <Tag>{members.length} 份已选</Tag>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              placeholder="选择同一收件方的多份资料包"
              value={selectedIds}
              onChange={(values) => {
                setSelectedIds(values)
                setAmounts((current) => {
                  const next: Record<string, number> = {}
                  values.forEach((id) => {
                    next[id] = current[id] ?? 5
                  })
                  return next
                })
              }}
              options={data.packages.map((item) => ({
                value: item.id,
                label: `${item.code} · ${item.title} · ${item.recipient}`,
              }))}
            />
            {members.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1 }}>
                  {item.code} · 剩余额度 {item.quotaLimit - item.quotaUsed}
                </span>
                <InputNumber
                  min={1}
                  max={Math.max(1, item.quotaLimit - item.quotaUsed)}
                  value={amounts[item.id] ?? 5}
                  onChange={(value) =>
                    setAmounts((current) => ({ ...current, [item.id]: value ?? 1 }))
                  }
                  addonAfter="预占"
                />
              </div>
            ))}
            {createProblems.map((problem) => (
              <Alert key={problem} type="warning" showIcon message={problem} />
            ))}
            {plan && !plan.problems.length ? (
              <Alert
                type="info"
                showIcon
                message={`按规则预占总额度 ${plan.items.reduce((sum, item) => sum + item.amount, 0)}，建批后立即生效。`}
              />
            ) : null}
            <Button
              type="primary"
              block
              icon={<PartitionOutlined />}
              disabled={members.length < 2 || createProblems.length > 0}
              loading={createState.isLoading}
              onClick={submitCreate}
            >
              创建联合批次并预占额度
            </Button>
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>建批校验说明</h3>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <div>
              <strong>一致性校验</strong>
              <p className="muted">收件方、目的地和最终用途必须完全一致，否则不能并入同一出口批次。</p>
            </div>
            <div>
              <strong>按规则预占</strong>
              <p className="muted">
                逐包核对剩余额度，并按许可规则汇总核对总额度；其他生效批次的预占会扣减可用额度。
              </p>
            </div>
            <div>
              <strong>失效与待核</strong>
              <p className="muted">
                任一成员换版或内容变化，整批预占立即失效转待核；已通过步骤和许可记录保留，重新校验后恢复。
              </p>
            </div>
            <div>
              <strong>幂等核销</strong>
              <p className="muted">
                同一批次并发提交只成功一次；核销失败预占保留可重试，重复核销不重复扣减。
              </p>
            </div>
          </Space>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>批次列表</h3>
          <Tag>{data.batches.length} 个批次</Tag>
        </div>
        <Table
          rowKey="id"
          columns={batchColumns}
          dataSource={data.batches}
          pagination={false}
          rowClassName={(record) => (record.id === activeBatchId ? 'ant-table-row-selected' : '')}
          onRow={(record) => ({ onClick: () => setActiveBatchId(record.id) })}
          locale={{ emptyText: '尚未创建联合许可批次' }}
        />
      </section>

      {activeBatch ? (
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>{activeBatch.code} 批次详情</h3>
              <Tag color={batchStatusColors[activeBatch.status]}>
                {batchStatusLabels[activeBatch.status]}
              </Tag>
            </div>
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              {activeBatch.status === 'pending-review' ? (
                <Alert
                  type="warning"
                  showIcon
                  message="整批预占已失效，批次转待核"
                  description={`${activeBatch.statusReason} 已通过步骤和许可记录保留，重新校验通过后预占恢复。`}
                />
              ) : null}
              {activeBatch.status === 'settled' ? (
                <Alert
                  type="success"
                  showIcon
                  message={`批次已核销，共扣减 ${activeBatch.totalReserved} 额度，重复核销不会重复扣减。`}
                />
              ) : null}
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="收件方">{activeBatch.recipient}</Descriptions.Item>
                <Descriptions.Item label="目的地">{activeBatch.destination}</Descriptions.Item>
                <Descriptions.Item label="最终用途">{activeBatch.endUse}</Descriptions.Item>
                <Descriptions.Item label="预占总额度">{activeBatch.totalReserved}</Descriptions.Item>
                <Descriptions.Item label="核销时间">
                  {activeBatch.settledAt
                    ? new Date(activeBatch.settledAt).toLocaleString('zh-CN', { hour12: false })
                    : '未核销'}
                </Descriptions.Item>
              </Descriptions>
              <Table
                rowKey="id"
                columns={memberColumns}
                dataSource={activeMembers}
                pagination={false}
                size="small"
              />
            </Space>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>预占与核销</h3>
              <Space>
                {activeBatch.status === 'pending-review' ? (
                  <Button
                    type="primary"
                    loading={recheckState.isLoading}
                    onClick={() => recheck(activeBatch.id)}
                  >
                    重新校验预占
                  </Button>
                ) : null}
                {activeBatch.status === 'reserved' ? (
                  <Popconfirm
                    title="核销整批预占额度"
                    description="将按预占明细逐包扣减许可额度，扣减失败时整批预占保留。"
                    okText="确认核销"
                    cancelText="取消"
                    onConfirm={() => settle(activeBatch.id)}
                  >
                    <Button type="primary" loading={settleState.isLoading}>
                      核销扣减
                    </Button>
                  </Popconfirm>
                ) : null}
              </Space>
            </div>
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Table
                rowKey={(record) => record.packageId}
                columns={reservationColumns}
                dataSource={activeBatch.reservations}
                pagination={false}
                size="small"
              />
              {activeBatch.deductions.length ? (
                <div>
                  <strong>扣减记录</strong>
                  <div style={{ marginTop: 8 }}>
                    {activeBatch.deductions.map((deduction) => (
                      <Tag key={deduction.packageId} color="green" style={{ marginBottom: 6 }}>
                        {deduction.packageCode} 扣减 {deduction.amount} ·{' '}
                        {new Date(deduction.deductedAt).toLocaleString('zh-CN', { hour12: false })}
                      </Tag>
                    ))}
                  </div>
                </div>
              ) : (
                <span className="muted">尚无扣减记录。</span>
              )}
            </Space>
          </section>
        </div>
      ) : null}
    </div>
  )
}
