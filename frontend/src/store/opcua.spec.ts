// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useOpcuaStore } from './opcua'
import type { AlarmEvent, AlarmSeverity } from '../types'

const STORAGE_KEYS = [
  'opcua:alarms',
  'opcua:alarm-filter',
  'opcua:alarm-batches',
  'opcua:alarm-batch-seq'
]

function seedAlarms(store: ReturnType<typeof useOpcuaStore>, spec: Array<[AlarmSeverity, boolean]>) {
  spec.forEach(([severity, acked], idx) => {
    const alarm: AlarmEvent = {
      id: `a${idx}`,
      nodeId: `ns=2;i=${idx}`,
      nodeName: `Node_${idx}`,
      severity,
      message: `${severity} message ${idx}`,
      timestamp: 1000 + idx,
      acknowledged: acked,
      ackBatchId: null
    }
    store.alarms.push(alarm)
  })
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('alarm store', () => {
  it('按严重程度分组且保持固定顺序', () => {
    const store = useOpcuaStore()
    seedAlarms(store, [['Info', false], ['Critical', false], ['High', false]])
    const groups = store.groupedAlarms.map(g => g.severity)
    expect(groups).toEqual(['Critical', 'High', 'Medium', 'Low', 'Info'])
    expect(store.groupedAlarms[0].items[0].id).toBe('a1')
    expect(store.groupedAlarms[4].items[0].id).toBe('a0')
  })

  it('筛选未确认高等级：活跃/总计数字与列表一致', () => {
    const store = useOpcuaStore()
    seedAlarms(store, [
      ['Critical', false],
      ['Critical', true],
      ['High', false],
      ['Medium', false],
      ['Info', true]
    ])
    store.applyHighLevelActiveFilter()

    expect(store.filteredAlarms.map(a => a.id).sort()).toEqual(['a0', 'a2'])
    expect(store.activeAlarmsCount).toBe(2)
    expect(store.totalAlarmsCount).toBe(2)
  })

  it('关键词与状态筛选生效', () => {
    const store = useOpcuaStore()
    seedAlarms(store, [['High', false], ['High', true]])
    store.setKeywordFilter('message 0')
    expect(store.totalAlarmsCount).toBe(1)
    store.setKeywordFilter('')
    store.setStatusFilter('acknowledged')
    expect(store.filteredAlarms.map(a => a.id)).toEqual(['a1'])
  })

  it('批量确认逐条执行，成功条目记录所属批次', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9) // >= 失败率 -> 成功
    const store = useOpcuaStore()
    seedAlarms(store, [['Critical', false], ['High', false], ['Medium', true]])
    const batch = store.acknowledgeAlarmsBatch()
    expect(batch).not.toBeNull()
    expect(batch!.items).toHaveLength(2)
    await vi.waitFor(() => expect(batch!.running).toBe(false))

    expect(store.alarms.find(a => a.id === 'a0')!.acknowledged).toBe(true)
    expect(store.alarms.find(a => a.id === 'a0')!.ackBatchId).toBe(batch!.id)
    expect(store.alarms.find(a => a.id === 'a1')!.ackBatchId).toBe(batch!.id)
    expect(store.batchItemCount(batch!, 'success')).toBe(2)
    expect(store.batchItemCount(batch!, 'failed')).toBe(0)
  })

  it('中途失败的条目留在同一批次，可单条重试成功', async () => {
    const store = useOpcuaStore()
    seedAlarms(store, [['Critical', false], ['High', false]])
    // 前两次 Math.random 分别用于批次 ID 与第一条确认；第一条失败、第二条成功
    let call = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      call += 1
      return call === 2 ? 0.01 : 0.9
    })
    const batch = store.acknowledgeAlarmsBatch()!
    await vi.waitFor(() => expect(batch.running).toBe(false))

    expect(store.batchItemCount(batch, 'failed')).toBe(1)
    const failed = batch.items.find(i => i.status === 'failed')!
    expect(failed.alarmId).toBe('a0')
    expect(failed.error).toBeTruthy()
    expect(failed.attempts).toBe(1)
    // 失败条目未被确认，仍计入活跃
    expect(store.alarms.find(a => a.id === 'a0')!.acknowledged).toBe(false)
    expect(store.activeAlarmsCount).toBe(1)

    // 重试：同一份清单、同一条批次记录
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    store.retryBatchItem(batch.id, 'a0')
    await vi.waitFor(() =>
      expect(batch.items.find(i => i.alarmId === 'a0')!.status).toBe('success')
    )
    const item = batch.items.find(i => i.alarmId === 'a0')!
    expect(item.attempts).toBe(2)
    expect(store.alarms.find(a => a.id === 'a0')!.ackBatchId).toBe(batch.id)
    expect(store.ackBatches).toHaveLength(1)
  })

  it('刷新恢复：筛选条件、分组折叠、中断批次与报警来源均保持', () => {
    const store = useOpcuaStore()
    seedAlarms(store, [['Critical', false], ['High', false]])
    store.applyHighLevelActiveFilter()
    store.toggleGroupCollapsed('Medium')
    // 模拟一个正在运行中的批次并持久化（通过 localStorage 直接构造）
    const runningBatch = {
      id: 'b1',
      seq: 7,
      source: 'batch' as const,
      createdAt: 1234,
      filter: { severities: ['Critical'], status: 'active' as const, keyword: '' },
      running: true,
      items: [
        { alarmId: 'a0', nodeName: 'Node_0', message: 'm', severity: 'Critical' as const, status: 'pending' as const, attempts: 1 }
      ]
    }
    localStorage.setItem('opcua:alarm-batches', JSON.stringify([runningBatch]))
    localStorage.setItem('opcua:alarm-batch-seq', '8')
    localStorage.setItem('opcua:alarms', JSON.stringify(store.alarms))

    // 模拟页面刷新：新建 Pinia 实例，store 从 localStorage 重新初始化
    setActivePinia(createPinia())
    const restored = useOpcuaStore()
    expect(restored.filter.severities).toEqual(['Critical', 'High'])
    expect(restored.filter.status).toBe('active')
    expect(restored.filter.collapsedGroups).toEqual(['Medium'])
    const batch = restored.ackBatches[0]
    expect(batch.running).toBe(false)
    expect(batch.items[0].status).toBe('failed')
    expect(batch.items[0].error).toContain('刷新')
  })

  it('单条确认入口不受批量流程影响，标记为手动确认', () => {
    const store = useOpcuaStore()
    seedAlarms(store, [['High', false]])
    store.acknowledgeAlarm('a0')
    const alarm = store.alarms.find(a => a.id === 'a0')!
    expect(alarm.acknowledged).toBe(true)
    expect(alarm.ackBatchId).toBeNull()
  })

  it('清空会同时清掉报警与待处理清单', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const store = useOpcuaStore()
    seedAlarms(store, [['High', false]])
    store.acknowledgeAlarmsBatch()
    await vi.waitFor(() => expect(store.ackBatches.length).toBe(1))
    store.clearAlarms()
    expect(store.alarms).toEqual([])
    expect(store.ackBatches).toEqual([])
    expect(store.activeAlarmsCount).toBe(0)
    expect(store.totalAlarmsCount).toBe(0)
  })
})
