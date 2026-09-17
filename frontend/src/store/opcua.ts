import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  OPCUANode,
  DataValue,
  AlarmEvent,
  AlarmSeverity,
  AlarmFilterState,
  SubscriptionConfig,
  AckBatch,
  AckBatchItem,
  AckItemStatus
} from '../types'

const ALARMS_STORAGE_KEY = 'opcua:alarms'
const FILTER_STORAGE_KEY = 'opcua:alarm-filter'
const BATCHES_STORAGE_KEY = 'opcua:alarm-batches'
const BATCH_SEQ_KEY = 'opcua:alarm-batch-seq'
const MAX_ALARMS = 50
const MAX_BATCHES = 50
// 模拟逐条确认时的网络/后端处理耗时
const ACK_ITEM_DELAY = 280
// 模拟确认接口的随机失败概率（可重试）
const ACK_FAILURE_RATE = 0.15
const ACK_ERROR_MESSAGES = [
  'OPC-UA 服务器响应超时',
  '确认服务暂时不可用 (503)',
  '节点连接中断，指令未送达',
  '写入冲突，请稍后重试'
]

const SEVERITY_ORDER: AlarmSeverity[] = ['Critical', 'High', 'Medium', 'Low', 'Info']

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储空间不足等情况下静默忽略，不影响页面功能
  }
}

function randomAckError(): string {
  return ACK_ERROR_MESSAGES[Math.floor(Math.random() * ACK_ERROR_MESSAGES.length)]
}

export const useOpcuaStore = defineStore('opcua', () => {
  // 状态
  const nodeTree = ref<OPCUANode[]>([])
  const selectedNode = ref<OPCUANode | null>(null)
  const subscriptions = ref<Map<string, SubscriptionConfig>>(new Map())
  // 报警与批量清单从 localStorage 恢复，刷新/切回页面后仍在
  const alarms = ref<AlarmEvent[]>(loadJson<AlarmEvent[]>(ALARMS_STORAGE_KEY, []))
  const ackBatches = ref<AckBatch[]>(loadJson<AckBatch[]>(BATCHES_STORAGE_KEY, []))
  const batchSeq = ref<number>(Number(loadJson<number>(BATCH_SEQ_KEY, 1)) || 1)
  // 上次中断时仍在执行的批次，恢复后标记为可重试的失败状态
  ackBatches.value.forEach(batch => {
    if (batch.running) {
      batch.running = false
      batch.items.forEach(item => {
        if (item.status === 'pending') {
          item.status = 'failed'
          item.error = '页面刷新导致操作中断'
        }
      })
    }
  })

  const defaultFilter: AlarmFilterState = {
    severities: [],
    status: 'all',
    keyword: '',
    collapsedGroups: []
  }
  const filter = ref<AlarmFilterState>({ ...defaultFilter, ...loadJson(FILTER_STORAGE_KEY, defaultFilter) })

  const realTimeData = ref<Map<string, DataValue>>(new Map())
  const isConnected = ref(false)
  const dataHistory = ref<Map<string, Array<{ timestamp: number; value: number }>>>(new Map())

  let batchRunning = false

  function persistAlarms() {
    saveJson(ALARMS_STORAGE_KEY, alarms.value)
  }

  function persistBatches() {
    saveJson(BATCHES_STORAGE_KEY, ackBatches.value)
    saveJson(BATCH_SEQ_KEY, batchSeq.value)
  }

  function persistFilter() {
    saveJson(FILTER_STORAGE_KEY, filter.value)
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
      acknowledged: false,
      ackBatchId: null
    }
    alarms.value.unshift(newAlarm)
    if (alarms.value.length > MAX_ALARMS) {
      alarms.value.length = MAX_ALARMS
    }
    persistAlarms()
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

  // 确认报警（原有的单条确认入口，保持不变）
  function acknowledgeAlarm(alarmId: string) {
    const alarm = alarms.value.find(a => a.id === alarmId)
    if (alarm && !alarm.acknowledged) {
      alarm.acknowledged = true
      alarm.acknowledgedAt = Date.now()
      alarm.ackBatchId = null
      persistAlarms()
    }
  }

  // 清空报警（同时清空待处理清单）
  function clearAlarms() {
    alarms.value = []
    ackBatches.value = []
    batchRunning = false
    persistAlarms()
    persistBatches()
  }

  // 连接模拟
  function connect() {
    isConnected.value = true
    initNodeTree()
  }

  // 断开连接
  function disconnect() {
    isConnected.value = false
  }

  // ---- 筛选与分组 ----

  function setSeverityFilter(severities: AlarmSeverity[]) {
    filter.value.severities = severities
    persistFilter()
  }

  function setStatusFilter(status: AlarmFilterState['status']) {
    filter.value.status = status
    persistFilter()
  }

  function setKeywordFilter(keyword: string) {
    filter.value.keyword = keyword
    persistFilter()
  }

  // 快捷筛选：未确认的高等级（严重 + 高）条目
  function applyHighLevelActiveFilter() {
    filter.value.severities = ['Critical', 'High']
    filter.value.status = 'active'
    persistFilter()
  }

  function toggleGroupCollapsed(severity: AlarmSeverity) {
    const idx = filter.value.collapsedGroups.indexOf(severity)
    if (idx >= 0) {
      filter.value.collapsedGroups.splice(idx, 1)
    } else {
      filter.value.collapsedGroups.push(severity)
    }
    persistFilter()
  }

  // 经过当前筛选条件后的报警（顶部导航数字与下方列表都基于它）
  const filteredAlarms = computed<AlarmEvent[]>(() => {
    const keyword = filter.value.keyword.trim().toLowerCase()
    return alarms.value.filter(a => {
      if (filter.value.severities.length > 0 && !filter.value.severities.includes(a.severity)) {
        return false
      }
      if (filter.value.status === 'active' && a.acknowledged) return false
      if (filter.value.status === 'acknowledged' && !a.acknowledged) return false
      if (
        keyword &&
        !`${a.nodeName} ${a.message}`.toLowerCase().includes(keyword)
      ) {
        return false
      }
      return true
    })
  })

  // 按严重程度分组，组内按时间倒序；始终按固定顺序展示全部五个等级
  const groupedAlarms = computed<Array<{ severity: AlarmSeverity; items: AlarmEvent[] }>>(() => {
    const groups = new Map<AlarmSeverity, AlarmEvent[]>()
    SEVERITY_ORDER.forEach(s => groups.set(s, []))
    filteredAlarms.value.forEach(a => {
      groups.get(a.severity)?.push(a)
    })
    return SEVERITY_ORDER.map(severity => ({
      severity,
      items: (groups.get(severity) ?? []).sort((x, y) => y.timestamp - x.timestamp)
    }))
  })

  // 当前视图下未确认的条目（批量确认的默认范围）
  const activeFilteredAlarms = computed(() => filteredAlarms.value.filter(a => !a.acknowledged))

  // ---- 批量确认（逐条处理，失败与重试结果落在同一份待处理清单） ----

  function delay(ms: number) {
    return new Promise(resolve => window.setTimeout(resolve, ms))
  }

  // 模拟对单条报警调用确认接口
  async function callAckApi(): Promise<void> {
    await delay(ACK_ITEM_DELAY)
    if (Math.random() < ACK_FAILURE_RATE) {
      throw new Error(randomAckError())
    }
  }

  function applyAckSuccess(alarmId: string, batchId: string) {
    const alarm = alarms.value.find(a => a.id === alarmId)
    if (alarm) {
      alarm.acknowledged = true
      alarm.ackBatchId = batchId
      alarm.acknowledgedAt = Date.now()
    }
  }

  // 发起一次批量确认；alarmIds 缺省时作用于当前筛选结果中全部未确认条目
  function acknowledgeAlarmsBatch(
    alarmIds?: string[],
    source: AckBatch['source'] = 'batch'
  ): AckBatch | null {
    if (batchRunning) return null

    const targets = activeFilteredAlarms.value.filter(
      a => !alarmIds || alarmIds.includes(a.id)
    )
    if (targets.length === 0) return null

    const batch: AckBatch = {
      id: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      seq: batchSeq.value++,
      source,
      createdAt: Date.now(),
      filter: {
        severities: [...filter.value.severities],
        status: filter.value.status,
        keyword: filter.value.keyword
      },
      running: true,
      items: targets.map<AckBatchItem>(a => ({
        alarmId: a.id,
        nodeName: a.nodeName,
        message: a.message,
        severity: a.severity,
        status: 'pending',
        attempts: 0
      }))
    }
    ackBatches.value.unshift(batch)
    if (ackBatches.value.length > MAX_BATCHES) ackBatches.value.length = MAX_BATCHES
    batchRunning = true
    persistBatches()

    void runPendingItems(batch)
    return batch
  }

  // 逐条处理批次内所有待处理/失败的条目；首次执行与重试走同一条路径
  async function runPendingItems(batch: AckBatch) {
    batch.running = true
    batchRunning = true
    for (const item of batch.items) {
      if (item.status === 'success') continue
      item.status = 'processing'
      item.error = undefined
      item.attempts += 1
      persistBatches()
      try {
        await callAckApi()
        item.status = 'success'
        item.acknowledgedAt = Date.now()
        applyAckSuccess(item.alarmId, batch.id)
      } catch (err) {
        item.status = 'failed'
        item.error = err instanceof Error ? err.message : '未知错误'
      }
      persistBatches()
      persistAlarms()
    }
    batch.running = false
    batchRunning = false
    persistBatches()
  }

  // 重试单个失败条目，结果仍落在原批次里
  function retryBatchItem(batchId: string, alarmId: string) {
    if (batchRunning) return
    const batch = ackBatches.value.find(b => b.id === batchId)
    const item = batch?.items.find(i => i.alarmId === alarmId)
    if (!batch || !item || item.status === 'success' || batch.running) return
    void runPendingItems(batch)
  }

  // 重试某批次内全部失败条目
  function retryBatchFailed(batchId: string) {
    if (batchRunning) return
    const batch = ackBatches.value.find(b => b.id === batchId)
    if (!batch || batch.running || !batch.items.some(i => i.status === 'failed')) return
    void runPendingItems(batch)
  }

  // 从待处理清单中移除一条批次记录（不影响报警本身的确认状态）
  function dismissBatch(batchId: string) {
    const batch = ackBatches.value.find(b => b.id === batchId)
    if (!batch || batch.running) return
    ackBatches.value = ackBatches.value.filter(b => b.id !== batchId)
    persistBatches()
  }

  function batchItemCount(batch: AckBatch, status: AckItemStatus) {
    return batch.items.filter(i => i.status === status).length
  }

  // 计算属性
  const activeAlarmsCount = computed(() => filteredAlarms.value.filter(a => !a.acknowledged).length)
  const totalAlarmsCount = computed(() => filteredAlarms.value.length)
  const criticalAlarmsCount = computed(() =>
    alarms.value.filter(a => a.severity === 'Critical' && !a.acknowledged).length
  )
  const pendingBatches = computed(() =>
    ackBatches.value.filter(b => b.running || b.items.some(i => i.status === 'failed'))
  )
  const batchInProgress = computed(() => batchRunning)

  return {
    // 状态
    nodeTree,
    selectedNode,
    subscriptions,
    alarms,
    ackBatches,
    filter,
    realTimeData,
    isConnected,
    dataHistory,
    // 方法
    initNodeTree,
    simulateDataUpdate,
    selectNode,
    addSubscription,
    removeSubscription,
    acknowledgeAlarm,
    clearAlarms,
    connect,
    disconnect,
    getAllVariableNodes,
    // 筛选/分组
    setSeverityFilter,
    setStatusFilter,
    setKeywordFilter,
    applyHighLevelActiveFilter,
    toggleGroupCollapsed,
    filteredAlarms,
    groupedAlarms,
    activeFilteredAlarms,
    // 批量确认
    acknowledgeAlarmsBatch,
    retryBatchItem,
    retryBatchFailed,
    dismissBatch,
    batchItemCount,
    pendingBatches,
    batchInProgress,
    // 计算属性
    activeAlarmsCount,
    totalAlarmsCount,
    criticalAlarmsCount
  }
})
