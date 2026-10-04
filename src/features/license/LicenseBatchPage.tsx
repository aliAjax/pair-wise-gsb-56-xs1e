import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { PartitionOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { PageHeader } from '@/components/PageHeader'
import {
  useCreateLicenseBatchMutation,
  useDeductLicenseBatchMutation,
  useGetWorkspaceQuery,
  useRevalidateLicenseBatchMutation,
} from '@/app/api'
import type { LicenseBatch, LicenseBatchItem, MaterialPackage } from '@/types/domain'
import {
  batchStatusColors,
  batchStatusLabels,
  findActiveBatchForPackage,
  makeBatchIdempotencyKey,
  validateBatchComposition,
} from '@/services/batch'
import { packageStatusLabels } from '@/services/mockData'

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error && 'data' in error) {
    const detail = (error as { data?: { error?: string } }).data?.error
    if (detail) return detail
  }
  return fallback
}

export function LicenseBatchPage() {
  const { data, isLoading } = useGetWorkspaceQuery()
  const [createBatch, createState] = useCreateLicenseBatchMutation()
  const [deductBatch, deductState] = useDeductLicenseBatchMutation()
  const [revalidateBatch, revalidateState] = useRevalidateLicenseBatchMutation()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [amounts, setAmounts] = useState<Record<string, number>>({})
  const [selectedBatchId, setSelectedBatchId] = useState('')

  const batches = useMemo(() => data?.batches ?? [], [data])
  const selectedBatch = useMemo(
    () => batches.find((item) => item.id === selectedBatchId) ?? batches[0],
    [batches, selectedBatchId],
  )

  useEffect(() => {
    if (!selectedBatchId && batches[0]) setSelectedBatchId(batches[0].id)
  }, [batches, selectedBatchId])

  const selectedPackages = useMemo(
    () =>
      selectedIds
        .map((id) => data?.packages.find((item) => item.id === id))
        .filter((item): item is MaterialPackage => Boolean(item)),
    [data, selectedIds],
  )
  const compositionErrors = useMemo(
    () => (data ? validateBatchComposition(selectedPackages, data.rules) : []),
    [data, selectedPackages],
  )
  const idempotencyKey = useMemo(
    () => (selectedIds.length >= 2 ? makeBatchIdempotencyKey(selectedIds) : ''),
    [selectedIds],
  )
  const totalReserved = selectedIds.reduce((sum, id) => sum + (amounts[id] ?? 5), 0)

  if (isLoading || !data) return <div className="panel">正在加载联合许可批次...</div>

  const consistency = [
    { label: '收件方', values: [...new Set(selectedPackages.map((item) => item.recipient))] },
    { label: '目的地', values: [...new Set(selectedPackages.map((item) => item.destination))] },
    { label: '最终用途', values: [...new Set(selectedPackages.map((item) => item.endUse))] },
  ]

  const batchColumns: TableColumnsType<LicenseBatch> = [
    { title: '批次号', dataIndex: 'code', width: 120 },
    { title: '收件方', dataIndex: 'recipient', minWidth: 210 },
    { title: '目的地', dataIndex: 'destination', width: 90 },
    {
      title: '资料包',
      width: 80,
      render: (_, record) => `${record.items.length} 份`,
    },
    { title: '预占总额度', dataIndex: 'totalReserved', width: 105 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 95,
      render: (value: LicenseBatch['status']) => (
        <Tag color={batchStatusColors[value]}>{batchStatusLabels[value]}</Tag>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 165,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
  ]

  const itemColumns: TableColumnsType<LicenseBatchItem> = [
    {
      title: '资料包',
      width: 240,
      render: (_, record) => {
        const packageItem = data.packages.find((item) => item.id === record.packageId)
        return packageItem ? `${packageItem.code} · ${packageItem.title}` : record.packageId
      },
    },
    { title: '适用规则', dataIndex: 'ruleName', minWidth: 220 },
    { title: '预占额度', dataIndex: 'amount', width: 90 },
    {
      title: '审批状态',
      width: 100,
      render: (_, record) => {
        const packageItem = data.packages.find((item) => item.id === record.packageId)
        return packageItem ? packageStatusLabels[packageItem.status] : '未知'
      },
    },
    {
      title: '核销',
      width: 110,
      render: (_, record) =>
        record.deducted ? (
          <Tag color="success">已核销</Tag>
        ) : (
          <Tag color={selectedBatch?.status === 'pending-review' ? 'warning' : 'processing'}>
            预占中
          </Tag>
        ),
    },
    {
      title: '核销时间',
      dataIndex: 'deductedAt',
      width: 165,
      render: (value: string | undefined) =>
        value ? new Date(value).toLocaleString('zh-CN') : <span className="muted">—</span>,
    },
  ]

  async function submitCreate() {
    try {
      const result = await createBatch({
        packageIds: selectedIds,
        amounts: Object.fromEntries(selectedIds.map((id) => [id, amounts[id] ?? 5])),
        idempotencyKey,
        createdBy: '当前用户',
      }).unwrap()
      setSelectedBatchId(result.batch.id)
      if (result.deduplicated) {
        message.info(`批次 ${result.batch.code} 已存在（另一窗口可能已先行创建），已读取现有批次`)
      } else {
        message.success(`联合许可批次 ${result.batch.code} 已创建，整批预占额度 ${result.batch.totalReserved}`)
      }
      setSelectedIds([])
    } catch (error) {
      message.error(errorText(error, '创建联合许可批次失败'))
    }
  }

  async function submitDeduct() {
    if (!selectedBatch) return
    try {
      const result = await deductBatch({ batchId: selectedBatch.id }).unwrap()
      if (result.idempotent) {
        message.info(`批次 ${result.batch.code} 已核销，本次未重复扣减`)
      } else {
        message.success(`批次 ${result.batch.code} 整批核销完成，合计扣减 ${result.batch.totalReserved}`)
      }
    } catch (error) {
      message.error(errorText(error, '批次核销失败'))
    }
  }

  async function submitRevalidate() {
    if (!selectedBatch) return
    try {
      const result = await revalidateBatch({ batchId: selectedBatch.id }).unwrap()
      message.success(`批次 ${result.batch.code} 复核通过，整批预占恢复有效`)
    } catch (error) {
      message.error(errorText(error, '批次复核未通过'))
    }
  }

  return (
    <div>
      <PageHeader
        title="联合许可批次"
        description="同一收件方的多份资料包按批次统一预占、统一核销许可额度，避免分别扣减拆散出口批次。"
      />

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>创建联合批次</h3>
            <Tag>{selectedIds.length} 份资料包</Tag>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              placeholder="选择同一收件方的多份资料包"
              value={selectedIds}
              onChange={setSelectedIds}
              options={data.packages.map((item) => {
                const blocking = findActiveBatchForPackage(batches, item.id)
                return {
                  value: item.id,
                  disabled: Boolean(blocking),
                  label: `${item.code} · ${item.title} · ${item.recipient}${
                    blocking ? `（已在 ${blocking.code}）` : ''
                  }`,
                }
              })}
            />
            {selectedPackages.length ? (
              <div>
                {consistency.map((entry) => (
                  <div key={entry.label} style={{ marginBottom: 8 }}>
                    <strong>{entry.label}</strong>
                    <div style={{ marginTop: 4 }}>
                      {entry.values.map((value) => (
                        <Tag key={value} color={entry.values.length === 1 ? 'success' : 'error'}>
                          {value}
                        </Tag>
                      ))}
                      {entry.values.length > 1 ? (
                        <span className="muted">不一致，不能建批</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {selectedPackages.map((item) => (
              <div key={item.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ flex: 1 }}>
                  {item.code}（已用 {item.quotaUsed} / 上限 {item.quotaLimit}）
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
            {selectedIds.length >= 2
              ? compositionErrors.map((error) => (
                  <Alert key={error} type="error" showIcon message={error} />
                ))
              : null}
            {idempotencyKey ? (
              <div className="muted">
                幂等键：<span className="mono">{idempotencyKey}</span>
                ，两个窗口同时提交同一批次时只成功一次。
              </div>
            ) : null}
            <Button
              type="primary"
              block
              icon={<PartitionOutlined />}
              disabled={selectedIds.length < 2 || compositionErrors.length > 0}
              loading={createState.isLoading}
              onClick={submitCreate}
            >
              创建批次并预占总额度 {totalReserved}
            </Button>
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>批次列表</h3>
            <Tag>{batches.length} 个批次</Tag>
          </div>
          <Table
            rowKey="id"
            size="small"
            columns={batchColumns}
            dataSource={batches}
            pagination={false}
            rowClassName={(record) =>
              record.id === selectedBatch?.id ? 'ant-table-row-selected' : ''
            }
            onRow={(record) => ({ onClick: () => setSelectedBatchId(record.id) })}
          />
        </section>
      </div>

      {selectedBatch ? (
        <section className="panel">
          <div className="panel-title">
            <h3>
              批次详情 · {selectedBatch.code}{' '}
              <Tag color={batchStatusColors[selectedBatch.status]}>
                {batchStatusLabels[selectedBatch.status]}
              </Tag>
            </h3>
            <Space>
              {selectedBatch.status === 'pending-review' ? (
                <Button
                  type="primary"
                  icon={<ReloadOutlined />}
                  loading={revalidateState.isLoading}
                  onClick={submitRevalidate}
                >
                  重新校验恢复预占
                </Button>
              ) : null}
              {selectedBatch.status === 'reserved' ? (
                <Button
                  type="primary"
                  icon={<SafetyCertificateOutlined />}
                  loading={deductState.isLoading}
                  onClick={submitDeduct}
                >
                  整批核销扣减
                </Button>
              ) : null}
              {selectedBatch.status === 'licensed' ? (
                <Button loading={deductState.isLoading} onClick={submitDeduct}>
                  再次提交核销（幂等，不重复扣减）
                </Button>
              ) : null}
            </Space>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            {selectedBatch.invalidReason ? (
              <Alert type="warning" showIcon message={selectedBatch.invalidReason} />
            ) : null}
            {selectedBatch.lastDeductError ? (
              <Alert
                type="error"
                showIcon
                message="上次核销失败，整批预占保留，可修复后重试"
                description={selectedBatch.lastDeductError}
              />
            ) : null}
            <Descriptions column={3} bordered size="small">
              <Descriptions.Item label="收件方">{selectedBatch.recipient}</Descriptions.Item>
              <Descriptions.Item label="目的地">{selectedBatch.destination}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selectedBatch.endUse}</Descriptions.Item>
              <Descriptions.Item label="预占总额度">
                {selectedBatch.totalReserved}
              </Descriptions.Item>
              <Descriptions.Item label="创建">
                {selectedBatch.createdBy} ·{' '}
                {new Date(selectedBatch.createdAt).toLocaleString('zh-CN')}
              </Descriptions.Item>
              <Descriptions.Item label="幂等键">
                <span className="mono">{selectedBatch.idempotencyKey}</span>
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="packageId"
              size="small"
              columns={itemColumns}
              dataSource={selectedBatch.items}
              pagination={false}
            />
          </Space>
        </section>
      ) : (
        <section className="panel">
          <Alert type="info" showIcon message="暂无联合许可批次，请先选择同一收件方的多份资料包建批。" />
        </section>
      )}
    </div>
  )
}
