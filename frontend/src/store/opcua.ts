import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type {
  OPCUANode,
  DataValue,
  AlarmEvent,
  AlarmSeverity,
  AlarmFilterState,
  AlarmAckState,
  AckBatch,
  AckItemStatus,
  SubscriptionConfig
} from '../types'

// 严重程度从高到低，分组与排序均按此顺序
const SEVERITY_ORDER: AlarmSeverity[] = ['Critical', 'High', 'Medium', 'Low', 'Info']
const ALL_SEVERITIES: AlarmSeverity[] = [...SEVERITY_ORDER]

const STORAGE_KEYS = {
  alarms: 'opcua.alarms',
  filter: 'opcua.alarmFilter',
  collapsed: 'opcua.alarmGroupsCollapsed',
  ackBatches: 'opcua.ackBatches',
  itemStates: 'opcua.alarmAckStates'
} as const

const MAX_ALARMS = 50
const MAX_BATCHES = 20

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用时静默降级，内存状态仍可用
  }
}

// 模拟对后端发起的单条确认请求：随机延迟 + 随机失败，
// 重试（attempts 越大）成功率越高
function ackRequest(attempts: number): Promise<void> {
  const delay = 120 + Math.random() * 260
  const failed = Math.random() < Math.max(0.04, 0.22 - (attempts - 1) * 0.09)
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (failed) reject(new Error('确认请求超时，请重试'))
      else resolve()
    }, delay)
  })
}

export const useOpcuaStore = defineStore('opcua', () => {
  // 状态
  const nodeTree = ref<OPCUANode[]>([])
  const selectedNode = ref<OPCUANode | null>(null)
  const subscriptions = ref<Map<string, SubscriptionConfig>>(new Map())
  const isConnected = ref(false)
  const realTimeData = ref<Map<string, DataValue>>(new Map())
  const dataHistory = ref<Map<string, Array<{ timestamp: number; value: number }>>>(new Map())

  // ===== 报警相关状态（均持久化，刷新/切回页面后保留）=====
  const alarms = ref<AlarmEvent[]>(loadJSON<AlarmEvent[]>(STORAGE_KEYS.alarms, []))

  const alarmFilter = ref<AlarmFilterState>(
    loadJSON<AlarmFilterState>(STORAGE_KEYS.filter, {
      status: 'unacknowledged',
      severities: [...ALL_SEVERITIES],
      keyword: ''
    })
  )

  // 折叠的严重程度分组
  const collapsedGroups = ref<AlarmSeverity[]>(
    loadJSON<AlarmSeverity[]>(STORAGE_KEYS.collapsed, [])
  )

  const ackBatches = ref<AckBatch[]>(loadJSON<AckBatch[]>(STORAGE_KEYS.ackBatches, []))
  // 条目粒度的处理状态：alarmId -> 当前/最近一次处理结果
  const itemAckStates = ref<Record<string, AlarmAckState>>(
    loadJSON<Record<string, AlarmAckState>>(STORAGE_KEYS.itemStates, {})
  )

  // 当前正在执行的批量操作 ID（同一时刻只允许一个批量操作）
  const activeBatchId = ref<string | null>(null)

  // 持久化
  watch(alarms, value => persist(STORAGE_KEYS.alarms, value), { deep: true })
  watch(alarmFilter, value => persist(STORAGE_KEYS.filter, value), { deep: true })
  watch(collapsedGroups, value => persist(STORAGE_KEYS.collapsed, value), { deep: true })
  watch(ackBatches, value => persist(STORAGE_KEYS.ackBatches, value), { deep: true })
  watch(itemAckStates, value => persist(STORAGE_KEYS.itemStates, value), { deep: true })

  // 上次会话中若有未完成的批量操作，刷新后恢复为已结束，避免卡死在处理中
  for (const batch of ackBatches.value) {
    if (batch.status === 'running') {
      batch.status = 'done'
      batch.finishedAt = Date.now()
      recomputeBatchCounts(batch)
    }
  }
  for (const state of Object.values(itemAckStates.value)) {
    if (state.status === 'processing') {
      state.status = 'failed'
      state.error = '操作中断，请重试'
    }
  }

  function recomputeBatchCounts(batch: AckBatch) {
    let succeeded = 0
    let failed = 0
    for (const [alarmId, state] of Object.entries(itemAckStates.value)) {
      if (state.batchId !== batch.id || state.status === 'processing') continue
      const alarm = alarms.value.find(a => a.id === alarmId)
      if (state.status === 'success' || (alarm && alarm.acknowledged)) succeeded++
      else failed++
    }
    batch.succeeded = succeeded
    batch.failed = failed
  }

  // 初始化模拟节点树
  function initNodeTree() {
    nodeTree.value = [
      {
        id: 'server',
        name: 'Server',
        nodeId: 'ns=0;i=2253',
        type: 'Object',
        description: 'OPC-UA 服务器根节点',
        children: [
          {
            id: 'objects',
            name: 'Objects',
            nodeId: 'ns=0;i=85',
            type: 'Object',
            description: '对象文件夹',
            children: [
              {
                id: 'plc_area1',
                name: 'PLC_Area1',
                nodeId: 'ns=2;i=1001',
                type: 'Object',
                description: '1号生产区域 PLC',
                children: [
                  {
                    id: 'temp_sensor',
                    name: 'Temperature_Sensor',
                    nodeId: 'ns=2;i=1002',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 25.6,
                    unit: '°C',
                    quality: 'Good',
                    description: '温度传感器'
                  },
                  {
                    id: 'pressure_transmitter',
                    name: 'Pressure_Transmitter',
                    nodeId: 'ns=2;i=1003',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 3.45,
                    unit: 'MPa',
                    quality: 'Good',
                    description: '压力变送器'
                  },
                  {
                    id: 'pump_status',
                    name: 'Pump_Status',
                    nodeId: 'ns=2;i=1004',
                    type: 'Variable',
                    dataType: 'Boolean',
                    value: true,
                    quality: 'Good',
                    description: '泵运行状态'
                  }
                ]
              },
              {
                id: 'plc_area2',
                name: 'PLC_Area2',
                nodeId: 'ns=2;i=2001',
                type: 'Object',
                description: '2号生产区域 PLC',
                children: [
                  {
                    id: 'flow_meter',
                    name: 'Flow_Meter',
                    nodeId: 'ns=2;i=2002',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 156.7,
                    unit: 'L/min',
                    quality: 'Good',
                    description: '流量计'
                  },
                  {
                    id: 'valve_position',
                    name: 'Valve_Position',
                    nodeId: 'ns=2;i=2003',
                    type: 'Variable',
                    dataType: 'Double',
                    value: 75,
                    unit: '%',
                    quality: 'Good',
                    description: '阀门开度'
                  },
                  {
                    id: 'motor_speed',
                    name: 'Motor_Speed',
                    nodeId: 'ns=2;i=2004',
                    type: 'Variable',
                    dataType: 'Int32',
                    value: 1480,
                    unit: 'RPM',
                    quality: 'Good',
                    description: '电机转速'
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }

  // 模拟实时数据更新
  function simulateDataUpdate() {
    const nodes = getAllVariableNodes()
    nodes.forEach(node => {
      const currentValue = realTimeData.value.get(node.id)?.value ?? node.value

      let newValue: number | boolean | string
      if (node.dataType === 'Double') {
        const numVal = typeof currentValue === 'number' ? currentValue : parseFloat(String(currentValue))
        const variation = (Math.random() - 0.5) * 2
        newValue = Math.round((numVal + variation) * 100) / 100
      } else if (node.dataType === 'Int32') {
        const numVal = typeof currentValue === 'number' ? currentValue : parseInt(String(currentValue))
        const variation = Math.floor((Math.random() - 0.5) * 10)
        newValue = numVal + variation
      } else if (node.dataType === 'Boolean') {
        newValue = Math.random() > 0.95 ? !currentValue : currentValue
      } else {
        newValue = currentValue
      }

      const dataValue: DataValue = {
        nodeId: node.nodeId,
        value: newValue,
        quality: Math.random() > 0.98 ? 'Uncertain' : 'Good',
        timestamp: Date.now(),
        sourceTimestamp: Date.now(),
        serverTimestamp: Date.now()
      }

      realTimeData.value.set(node.id, dataValue)
      node.value = newValue
      node.quality = dataValue.quality

      // 记录历史数据
      const history = dataHistory.value.get(node.id) || []
      history.push({ timestamp: Date.now(), value: typeof newValue === 'number' ? newValue : 0 })
      if (history.length > 100) history.shift()
      dataHistory.value.set(node.id, history)

      // 检查报警条件
      checkAlarms(node, newValue)
    })
  }

  // 检查报警
  function checkAlarms(node: OPCUANode, value: number | boolean | string) {
    if (node.id === 'temp_sensor' && typeof value === 'number' && value > 28) {
      addAlarm({
        nodeId: node.nodeId,
        nodeName: node.name,
        severity: 'High',
        message: `温度过高: ${value}°C (阈值: 28°C)`,
        value,
        threshold: 28
      })
    }
    if (node.id === 'pressure_transmitter' && typeof value === 'number' && value > 4.0) {
      addAlarm({
        nodeId: node.nodeId,
        nodeName: node.name,
        severity: 'Critical',
        message: `压力超限: ${value} MPa (阈值: 4.0 MPa)`,
        value,
        threshold: 4.0
      })
    }
    if (node.id === 'motor_speed' && typeof value === 'number' && value > 1550) {
      addAlarm({
        nodeId: node.nodeId,
        nodeName: node.name,
        severity: 'Medium',
        message: `电机转速偏高: ${value} RPM (阈值: 1550 RPM)`,
        value,
        threshold: 1550
      })
    }
  }

  // 添加报警
  function addAlarm(alarm: Omit<AlarmEvent, 'id' | 'timestamp' | 'acknowledged'>) {
    const newAlarm: AlarmEvent = {
      ...alarm,
      id: `alarm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      acknowledged: false
    }
    alarms.value.unshift(newAlarm)
    if (alarms.value.length > MAX_ALARMS) {
      const removed = alarms.value.splice(MAX_ALARMS)
      removed.forEach(a => delete itemAckStates.value[a.id])
    }
  }

  // 获取所有变量节点
  function getAllVariableNodes(): OPCUANode[] {
    const variables: OPCUANode[] = []
    function traverse(nodes: OPCUANode[]) {
      nodes.forEach(node => {
        if (node.type === 'Variable') {
          variables.push(node)
        }
        if (node.children) {
          traverse(node.children)
        }
      })
    }
    traverse(nodeTree.value)
    return variables
  }

  // 选择节点
  function selectNode(node: OPCUANode) {
    selectedNode.value = node
  }

  // 添加订阅
  function addSubscription(nodeId: string, config: Partial<SubscriptionConfig> = {}) {
    const subscription: SubscriptionConfig = {
      nodeId,
      publishingInterval: config.publishingInterval || 1000,
      samplingInterval: config.samplingInterval || 500,
      queueSize: config.queueSize || 10,
      discardOldest: config.discardOldest ?? true,
      enabled: true
    }
    subscriptions.value.set(nodeId, subscription)
  }

  // 移除订阅
  function removeSubscription(nodeId: string) {
    subscriptions.value.delete(nodeId)
  }

  // ===== 筛选与分组 =====

  function setStatusFilter(status: AlarmFilterState['status']) {
    alarmFilter.value.status = status
  }

  function toggleSeverityFilter(severity: AlarmSeverity) {
    const list = alarmFilter.value.severities
    const index = list.indexOf(severity)
    if (index >= 0) list.splice(index, 1)
    else list.push(severity)
    // 保持按严重程度排序，分组顺序稳定
    list.sort((a, b) => SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b))
  }

  function setKeyword(keyword: string) {
    alarmFilter.value.keyword = keyword
  }

  function resetFilter() {
    alarmFilter.value.status = 'unacknowledged'
    alarmFilter.value.severities = [...ALL_SEVERITIES]
    alarmFilter.value.keyword = ''
  }

  function toggleGroupCollapsed(severity: AlarmSeverity) {
    const index = collapsedGroups.value.indexOf(severity)
    if (index >= 0) collapsedGroups.value.splice(index, 1)
    else collapsedGroups.value.push(severity)
  }

  // 当前筛选条件下的报警（顶栏计数与下方列表同源）
  const filteredAlarms = computed<AlarmEvent[]>(() => {
    const keyword = alarmFilter.value.keyword.trim().toLowerCase()
    return alarms.value.filter(alarm => {
      if (alarmFilter.value.status === 'unacknowledged' && alarm.acknowledged) return false
      if (alarmFilter.value.status === 'acknowledged' && !alarm.acknowledged) return false
      if (!alarmFilter.value.severities.includes(alarm.severity)) return false
      if (keyword) {
        const haystack = `${alarm.nodeName} ${alarm.message}`.toLowerCase()
        if (!haystack.includes(keyword)) return false
      }
      return true
    })
  })

  // 按严重程度分组（仅包含筛选结果中的条目，组内新报警在前）
  const groupedAlarms = computed<Array<{ severity: AlarmSeverity; items: AlarmEvent[] }>>(() => {
    return SEVERITY_ORDER.map(severity => ({
      severity,
      items: filteredAlarms.value.filter(a => a.severity === severity)
    })).filter(group => group.items.length > 0)
  })

  // 视图计数：与下方条目数量严格一致
  const viewActiveCount = computed(
    () => filteredAlarms.value.filter(a => !a.acknowledged).length
  )
  const viewTotalCount = computed(() => filteredAlarms.value.length)
  const viewCriticalCount = computed(
    () => filteredAlarms.value.filter(a => a.severity === 'Critical' && !a.acknowledged).length
  )

  const isFilterActive = computed(
    () =>
      alarmFilter.value.status !== 'unacknowledged' ||
      alarmFilter.value.severities.length !== ALL_SEVERITIES.length ||
      alarmFilter.value.keyword.trim() !== ''
  )

  // ===== 确认逻辑 =====

  // 原有的单条确认入口：保持同步、必然成功的语义
  function acknowledgeAlarm(alarmId: string) {
    const alarm = alarms.value.find(a => a.id === alarmId)
    if (alarm && !alarm.acknowledged) {
      alarm.acknowledged = true
      alarm.acknowledgedAt = Date.now()
      alarm.ackBatchId = null
    }
    // 该条目若此前在某批次中失败，从批次失败计数中移除并清理处理状态
    const state = itemAckStates.value[alarmId]
    if (state && state.status === 'failed') {
      const batch = ackBatches.value.find(b => b.id === state.batchId)
      if (batch && batch.failed > 0) batch.failed--
      delete itemAckStates.value[alarmId]
    }
  }

  function setItemState(
    alarmId: string,
    batchId: string,
    status: AckItemStatus,
    attempts: number,
    error?: string
  ) {
    itemAckStates.value[alarmId] = {
      batchId,
      status,
      attempts,
      error,
      updatedAt: Date.now()
    }
  }

  function createBatch(scope: AckBatch['scope'], severity: AlarmSeverity | null, targetIds: string[]) {
    const batch: AckBatch = {
      id: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      createdAt: Date.now(),
      status: 'running',
      scope,
      severity,
      total: targetIds.length,
      succeeded: 0,
      failed: 0,
      attempts: 1
    }
    ackBatches.value.unshift(batch)
    if (ackBatches.value.length > MAX_BATCHES) ackBatches.value.length = MAX_BATCHES
    return batch
  }

  // 逐条确认，逐条落地结果（成功立即确认，失败保留在待处理清单）
  async function runAckPass(batch: AckBatch, targetIds: string[], isRetry: boolean) {
    if (isRetry) batch.attempts++
    for (const alarmId of targetIds) {
      const alarm = alarms.value.find(a => a.id === alarmId)
      if (!alarm || alarm.acknowledged) continue

      const attempts = (itemAckStates.value[alarmId]?.attempts ?? 0) + 1
      setItemState(alarmId, batch.id, 'processing', attempts)
      try {
        await ackRequest(attempts)
        // 运行期间报警可能已被单条确认
        const current = alarms.value.find(a => a.id === alarmId)
        if (current && !current.acknowledged) {
          current.acknowledged = true
          current.acknowledgedAt = Date.now()
          current.ackBatchId = batch.id
        }
        setItemState(alarmId, batch.id, 'success', attempts)
        batch.succeeded++
      } catch (err) {
        setItemState(
          alarmId,
          batch.id,
          'failed',
          attempts,
          err instanceof Error ? err.message : '确认失败'
        )
        batch.failed++
      }
    }
  }

  // 批量确认当前筛选结果（或指定严重程度分组）中尚未确认的条目
  async function acknowledgeAlarms(
    scope: 'view' | 'severity' = 'view',
    severity: AlarmSeverity | null = null
  ): Promise<AckBatch | null> {
    if (activeBatchId.value) return null
    const targets = filteredAlarms.value
      .filter(a => !a.acknowledged && (scope === 'view' || a.severity === severity))
      .map(a => a.id)
    if (targets.length === 0) return null

    const batch = createBatch(scope, scope === 'severity' ? severity : null, targets)
    activeBatchId.value = batch.id
    try {
      await runAckPass(batch, targets, false)
    } finally {
      batch.status = 'done'
      batch.finishedAt = Date.now()
      activeBatchId.value = null
    }
    return batch
  }

  // 取某批次仍失败的条目（重试结果落在同一个 batchId 下，仍在同一份待处理清单）
  function getBatchFailedIds(batchId: string): string[] {
    return Object.entries(itemAckStates.value)
      .filter(([, state]) => state.batchId === batchId && state.status === 'failed')
      .map(([alarmId]) => alarmId)
      .filter(alarmId => {
        const alarm = alarms.value.find(a => a.id === alarmId)
        return alarm && !alarm.acknowledged
      })
  }

  // 重试整批失败条目；批次 ID 不变，attempts +1
  async function retryBatch(batchId: string): Promise<AckBatch | null> {
    if (activeBatchId.value) return null
    const batch = ackBatches.value.find(b => b.id === batchId)
    if (!batch) return null
    const failedIds = getBatchFailedIds(batchId)
    if (failedIds.length === 0) return batch

    // 重置上一轮计数，按本轮结果重新统计
    batch.failed = 0
    batch.succeeded = Math.max(0, batch.succeeded)
    batch.status = 'running'
    batch.finishedAt = undefined
    activeBatchId.value = batch.id
    try {
      await runAckPass(batch, failedIds, true)
    } finally {
      batch.status = 'done'
      batch.finishedAt = Date.now()
      activeBatchId.value = null
    }
    return batch
  }

  // 重试单条失败条目，结果仍归属于原来的批次
  async function retryItem(alarmId: string): Promise<void> {
    if (activeBatchId.value) return
    const state = itemAckStates.value[alarmId]
    const alarm = alarms.value.find(a => a.id === alarmId)
    if (!state || state.status !== 'failed' || !alarm || alarm.acknowledged) return
    const batch = ackBatches.value.find(b => b.id === state.batchId)
    if (!batch) return

    batch.status = 'running'
    batch.finishedAt = undefined
    activeBatchId.value = batch.id
    try {
      const attempts = state.attempts + 1
      setItemState(alarmId, batch.id, 'processing', attempts)
      try {
        await ackRequest(attempts)
        alarm.acknowledged = true
        alarm.acknowledgedAt = Date.now()
        alarm.ackBatchId = batch.id
        setItemState(alarmId, batch.id, 'success', attempts)
        if (batch.failed > 0) batch.failed--
        batch.succeeded++
      } catch (err) {
        setItemState(
          alarmId,
          batch.id,
          'failed',
          attempts,
          err instanceof Error ? err.message : '确认失败'
        )
      }
    } finally {
      batch.status = 'done'
      batch.finishedAt = Date.now()
      activeBatchId.value = null
    }
  }

  const activeBatch = computed(() =>
    activeBatchId.value ? ackBatches.value.find(b => b.id === activeBatchId.value) ?? null : null
  )

  // 最近一批有失败条目、可整体重试的操作
  const retryableBatch = computed(() => {
    if (activeBatchId.value) return null
    return ackBatches.value.find(b => getBatchFailedIds(b.id).length > 0) ?? null
  })

  // 清空报警（原有入口），同时清理条目处理状态
  function clearAlarms() {
    alarms.value = []
    itemAckStates.value = {}
  }

  // 连接模拟
  function connect() {
    isConnected.value = true
    if (nodeTree.value.length === 0) initNodeTree()
  }

  // 断开连接
  function disconnect() {
    isConnected.value = false
  }

  // 计算属性（全局口径，供其他视图使用）
  const activeAlarmsCount = computed(() => alarms.value.filter(a => !a.acknowledged).length)
  const criticalAlarmsCount = computed(() => alarms.value.filter(a => a.severity === 'Critical' && !a.acknowledged).length)

  return {
    // 状态
    nodeTree,
    selectedNode,
    subscriptions,
    alarms,
    realTimeData,
    isConnected,
    dataHistory,
    alarmFilter,
    collapsedGroups,
    ackBatches,
    itemAckStates,
    activeBatchId,
    // 方法
    initNodeTree,
    simulateDataUpdate,
    selectNode,
    addSubscription,
    removeSubscription,
    acknowledgeAlarm,
    acknowledgeAlarms,
    retryBatch,
    retryItem,
    getBatchFailedIds,
    clearAlarms,
    connect,
    disconnect,
    getAllVariableNodes,
    setStatusFilter,
    toggleSeverityFilter,
    setKeyword,
    resetFilter,
    toggleGroupCollapsed,
    // 计算属性
    filteredAlarms,
    groupedAlarms,
    viewActiveCount,
    viewTotalCount,
    viewCriticalCount,
    isFilterActive,
    activeBatch,
    retryableBatch,
    activeAlarmsCount,
    criticalAlarmsCount
  }
})
