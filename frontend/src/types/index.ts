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

// 报警事件
export interface AlarmEvent {
  id: string
  nodeId: string
  nodeName: string
  severity: AlarmSeverity
  message: string
  timestamp: number
  acknowledged: boolean
  value?: number | boolean | string
  threshold?: number
  // 被哪一次批量确认操作确认（手动单条确认为 null）
  ackBatchId?: string | null
  acknowledgedAt?: number
}

// 批量确认清单中单条条目的处理状态
export type AckItemStatus = 'pending' | 'processing' | 'success' | 'failed'

export interface AckBatchItem {
  alarmId: string
  nodeName: string
  message: string
  severity: AlarmSeverity
  status: AckItemStatus
  attempts: number
  error?: string
  acknowledgedAt?: number
}

// 一次批量确认操作（同一份待处理清单中的一条）
export interface AckBatch {
  id: string
  seq: number
  source: 'batch' | 'severity-group'
  createdAt: number
  // 命中的筛选条件（用于回看时说明该批次的范围）
  filter: {
    severities: AlarmSeverity[]
    status: 'all' | 'active' | 'acknowledged'
    keyword: string
  }
  items: AckBatchItem[]
  running: boolean
}

// 右侧报警面板的筛选/分组视图状态（持久化）
export interface AlarmFilterState {
  severities: AlarmSeverity[]
  status: 'all' | 'active' | 'acknowledged'
  keyword: string
  collapsedGroups: AlarmSeverity[]
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
