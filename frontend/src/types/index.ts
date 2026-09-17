// OPC-UA 节点类型定义
export interface OPCUANode {
  id: string
  name: string
  nodeId: string
  type: 'Object' | 'Variable' | 'Method' | 'DataType'
  dataType?: string
  value?: any
  unit?: string
  quality?: 'Good' | 'Bad' | 'Uncertain'
  children?: OPCUANode[]
  description?: string
  browseName?: string
}

// 数据值模型
export interface DataValue {
  nodeId: string
  value: number | boolean | string
  quality: 'Good' | 'Bad' | 'Uncertain'
  timestamp: number
  sourceTimestamp?: number
  serverTimestamp?: number
}

// 报警严重程度
export type AlarmSeverity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Info'

// 报警确认状态筛选
export type AlarmStatusFilter = 'unacknowledged' | 'acknowledged' | 'all'

// 报警事件
export interface AlarmEvent {
  id: string
  nodeId: string
  nodeName: string
  severity: AlarmSeverity
  message: string
  timestamp: number
  acknowledged: boolean
  acknowledgedAt?: number
  // 确认来源：null/undefined 表示单条确认；字符串为确认它的批量操作 ID
  ackBatchId?: string | null
  value?: number | boolean | string
  threshold?: number
}

// 报警筛选条件（持久化）
export interface AlarmFilterState {
  status: AlarmStatusFilter
  severities: AlarmSeverity[]
  keyword: string
}

// 批量确认中单个条目的处理状态
export type AckItemStatus = 'processing' | 'success' | 'failed'

export interface AlarmAckState {
  batchId: string
  status: AckItemStatus
  attempts: number
  error?: string
  updatedAt: number
}

// 批量确认操作记录
export interface AckBatch {
  id: string
  createdAt: number
  finishedAt?: number
  status: 'running' | 'done'
  // view: 确认当前筛选结果；severity: 确认某一严重程度分组
  scope: 'view' | 'severity'
  severity: AlarmSeverity | null
  total: number
  succeeded: number
  failed: number
  // 执行轮次，首轮为 1，每重试一轮 +1
  attempts: number
}

// 订阅配置
export interface SubscriptionConfig {
  nodeId: string
  publishingInterval: number
  samplingInterval: number
  queueSize: number
  discardOldest: boolean
  enabled: boolean
}

// 历史数据点
export interface HistoryDataPoint {
  timestamp: number
  value: number
  quality: 'Good' | 'Bad' | 'Uncertain'
}

// 节点详情
export interface NodeDetail {
  node: OPCUANode
  currentValue?: DataValue
  history?: HistoryDataPoint[]
  subscriptions?: SubscriptionConfig[]
}
