<template>
  <div class="app-container">
    <!-- 顶部导航栏 -->
    <header class="app-header">
      <div class="header-left">
        <el-icon :size="24" class="text-cyan-400"><Monitor /></el-icon>
        <h1 class="app-title">OPC-UA 工业节点浏览与数据采集</h1>
      </div>
      <div class="header-right">
        <el-tooltip content="当前列表中的未确认报警数" placement="bottom">
          <el-badge :value="store.activeAlarmsCount" :max="99" class="alarm-badge">
            <el-icon :size="20" class="text-yellow-400"><Bell /></el-icon>
          </el-badge>
        </el-tooltip>
        <el-tag type="danger" size="small" effect="dark" class="count-tag">
          活跃 {{ store.activeAlarmsCount }}
        </el-tag>
        <el-tooltip content="当前列表中的报警总数（含已确认）" placement="bottom">
          <el-tag type="info" size="small" effect="plain" class="count-tag">
            总计 {{ store.totalAlarmsCount }}
          </el-tag>
        </el-tooltip>
        <el-tag type="success" v-if="store.isConnected" class="status-tag">
          <el-icon><CircleCheck /></el-icon>
          在线
        </el-tag>
        <el-tag type="danger" v-else class="status-tag">
          <el-icon><CircleClose /></el-icon>
          离线
        </el-tag>
        <el-button
          :type="store.isConnected ? 'danger' : 'success'"
          size="small"
          @click="toggleConnection"
        >
          {{ store.isConnected ? '断开' : '连接' }}
        </el-button>
      </div>
    </header>

    <!-- 主内容区域 -->
    <div class="app-main">
      <!-- 左侧面板: 节点树 -->
      <aside class="left-panel">
        <NodeTree />
      </aside>

      <!-- 中央区域: 仪表盘 -->
      <main class="center-panel">
        <DataDashboard />
      </main>

      <!-- 右侧面板: 报警列表 -->
      <aside class="right-panel">
        <div class="alarm-panel">
          <div class="alarm-header">
            <h3 class="text-lg font-bold text-yellow-400">报警事件</h3>
            <el-button
              type="danger"
              size="small"
              text
              @click="handleClear"
              :disabled="store.alarms.length === 0"
            >
              清空
            </el-button>
          </div>

          <!-- 统计行：数字与下方筛选后的条目保持一致 -->
          <div class="alarm-stats">
            <el-tag type="danger" size="small">严重: {{ criticalCount }}</el-tag>
            <el-tag type="warning" size="small">活跃: {{ store.activeAlarmsCount }}</el-tag>
            <el-tag type="info" size="small">总计: {{ store.totalAlarmsCount }}</el-tag>
          </div>

          <!-- 筛选区 -->
          <div class="filter-bar">
            <el-select
              :model-value="store.filter.severities"
              multiple
              collapse-tags
              collapse-tags-tooltip
              size="small"
              placeholder="全部严重程度"
              class="filter-select"
              @update:model-value="store.setSeverityFilter"
            >
              <el-option
                v-for="s in severityOptions"
                :key="s.value"
                :label="s.label"
                :value="s.value"
              />
            </el-select>
            <el-select
              :model-value="store.filter.status"
              size="small"
              class="filter-status"
              @update:model-value="store.setStatusFilter"
            >
              <el-option label="全部状态" value="all" />
              <el-option label="未确认" value="active" />
              <el-option label="已确认" value="acknowledged" />
            </el-select>
            <el-input
              :model-value="store.filter.keyword"
              size="small"
              clearable
              placeholder="搜索节点 / 内容"
              class="filter-keyword"
              @update:model-value="store.setKeywordFilter"
            >
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <div class="filter-actions">
              <el-button
                size="small"
                type="danger"
                plain
                @click="store.applyHighLevelActiveFilter()"
              >
                未确认高等级
              </el-button>
              <el-button size="small" @click="resetFilter">重置</el-button>
              <el-button
                size="small"
                type="primary"
                :disabled="store.activeFilteredAlarms.length === 0 || store.batchInProgress"
                :loading="store.batchInProgress"
                @click="handleBatchAck"
              >
                批量确认{{ store.activeFilteredAlarms.length > 0 ? ` (${store.activeFilteredAlarms.length})` : '' }}
              </el-button>
            </div>
          </div>

          <div class="alarm-scroll">
            <!-- 待处理清单：逐条执行结果、失败重试 -->
            <section v-if="store.ackBatches.length > 0" class="pending-section">
              <div class="section-title">
                <el-icon><List /></el-icon>
                <span>待处理清单</span>
                <span class="section-count">{{ store.ackBatches.length }}</span>
              </div>
              <el-collapse v-model="expandedBatches" class="batch-collapse">
                <el-collapse-item
                  v-for="batch in store.ackBatches"
                  :key="batch.id"
                  :name="batch.id"
                >
                  <template #title>
                    <div class="batch-title">
                      <el-tag
                        :type="batchStatusType(batch)"
                        size="small"
                        effect="dark"
                      >
                        #{{ batch.seq }} {{ batchStatusLabel(batch) }}
                      </el-tag>
                      <span class="batch-meta">
                        {{ store.batchItemCount(batch, 'success') }}/{{ batch.items.length }}
                        成功<template v-if="store.batchItemCount(batch, 'failed') > 0">
                          · {{ store.batchItemCount(batch, 'failed') }} 失败
                        </template>
                      </span>
                      <span class="batch-time">{{ formatTime(batch.createdAt) }}</span>
                    </div>
                  </template>

                  <div class="batch-body">
                    <div class="batch-scope">
                      范围：{{ describeBatchScope(batch) }}
                    </div>
                    <div
                      v-for="item in batch.items"
                      :key="item.alarmId"
                      class="batch-item"
                      :class="`batch-item-${item.status}`"
                    >
                      <el-tag :type="getSeverityType(item.severity)" size="small" effect="plain">
                        {{ getSeverityLabel(item.severity) }}
                      </el-tag>
                      <span class="batch-item-name">{{ item.nodeName }}</span>
                      <span class="batch-item-status">
                        <el-icon v-if="item.status === 'processing'" class="is-loading"><Loading /></el-icon>
                        <el-icon v-else-if="item.status === 'success'" class="text-green-400"><CircleCheckFilled /></el-icon>
                        <el-icon v-else-if="item.status === 'failed'" class="text-red-400"><CircleCloseFilled /></el-icon>
                        <el-icon v-else class="text-slate-500"><Clock /></el-icon>
                        <span>{{ itemStatusLabel(item) }}</span>
                      </span>
                      <el-button
                        v-if="item.status === 'failed'"
                        type="warning"
                        size="small"
                        text
                        :disabled="store.batchInProgress"
                        @click="store.retryBatchItem(batch.id, item.alarmId)"
                      >
                        重试
                      </el-button>
                      <span v-if="item.attempts > 1" class="batch-item-attempts">第 {{ item.attempts }} 次</span>
                    </div>
                    <div v-if="failedItems(batch).length > 0" class="batch-errors">
                      <div v-for="item in failedItems(batch)" :key="item.alarmId + '-err'" class="batch-error">
                        {{ item.nodeName }}：{{ item.error }}
                      </div>
                    </div>
                    <div class="batch-footer">
                      <el-button
                        v-if="store.batchItemCount(batch, 'failed') > 0"
                        size="small"
                        type="warning"
                        plain
                        :disabled="store.batchInProgress || batch.running"
                        @click="store.retryBatchFailed(batch.id)"
                      >
                        重试全部失败项 ({{ store.batchItemCount(batch, 'failed') }})
                      </el-button>
                      <el-button
                        size="small"
                        text
                        :disabled="batch.running"
                        @click="store.dismissBatch(batch.id)"
                      >
                        移除记录
                      </el-button>
                    </div>
                  </div>
                </el-collapse-item>
              </el-collapse>
            </section>

            <!-- 按严重程度分组的报警列表 -->
            <section class="groups-section">
              <div
                v-for="group in store.groupedAlarms"
                :key="group.severity"
                class="alarm-group"
              >
                <div class="group-header" @click="store.toggleGroupCollapsed(group.severity)">
                  <el-icon class="group-caret">
                    <ArrowRight v-if="collapsedSeverities.includes(group.severity)" />
                    <ArrowDown v-else />
                  </el-icon>
                  <el-tag :type="getSeverityType(group.severity)" size="small" effect="dark">
                    {{ getSeverityLabel(group.severity) }}
                  </el-tag>
                  <span class="group-count">{{ group.items.length }}</span>
                  <el-button
                    v-if="groupActiveItems(group).length > 0"
                    type="primary"
                    size="small"
                    text
                    :disabled="store.batchInProgress"
                    @click.stop="handleGroupAck(group.severity)"
                  >
                    确认本组 ({{ groupActiveItems(group).length }})
                  </el-button>
                </div>

                <div v-show="!collapsedSeverities.includes(group.severity)" class="group-body">
                  <div
                    v-for="alarm in group.items"
                    :key="alarm.id"
                    class="alarm-item"
                    :class="{
                      'alarm-critical': alarm.severity === 'Critical',
                      'alarm-high': alarm.severity === 'High',
                      'alarm-medium': alarm.severity === 'Medium',
                      'alarm-low': alarm.severity === 'Low',
                      'alarm-info': alarm.severity === 'Info',
                      'alarm-acknowledged': alarm.acknowledged
                    }"
                  >
                    <div class="alarm-item-header">
                      <el-tag :type="getSeverityType(alarm.severity)" size="small" effect="dark">
                        {{ getSeverityLabel(alarm.severity) }}
                      </el-tag>
                      <span class="alarm-time">{{ formatTime(alarm.timestamp) }}</span>
                    </div>
                    <div class="alarm-item-body">
                      <span class="alarm-node">{{ alarm.nodeName }}</span>
                      <p class="alarm-message">{{ alarm.message }}</p>
                    </div>
                    <div class="alarm-item-footer">
                      <!-- 原有的单条确认入口，保持不变 -->
                      <el-button
                        v-if="!alarm.acknowledged"
                        type="primary"
                        size="small"
                        text
                        @click="store.acknowledgeAlarm(alarm.id)"
                      >
                        确认
                      </el-button>
                      <el-tooltip
                        v-else
                        :content="alarm.ackBatchId ? ackSourceTooltip(alarm) : '手动单条确认'"
                        placement="top"
                      >
                        <el-tag size="small" type="success" effect="plain" class="ack-tag">
                          <el-icon><CircleCheckFilled /></el-icon>
                          {{ ackSourceLabel(alarm) }} · {{ formatTime(alarm.acknowledgedAt ?? alarm.timestamp) }}
                        </el-tag>
                      </el-tooltip>
                    </div>
                  </div>
                  <div v-if="group.items.length === 0" class="group-empty">该等级下暂无条目</div>
                </div>
              </div>

              <div v-if="store.filteredAlarms.length === 0" class="no-alarms">
                <el-empty :description="store.alarms.length === 0 ? '暂无报警' : '当前筛选条件下没有匹配条目'" :image-size="60" />
              </div>
            </section>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Monitor, Bell, CircleCheck, CircleClose,
  Search, List, Loading, Clock,
  CircleCheckFilled, CircleCloseFilled,
  ArrowRight, ArrowDown
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useOpcuaStore } from './store/opcua'
import NodeTree from './components/NodeTree.vue'
import DataDashboard from './components/DataDashboard.vue'
import type { AlarmEvent, AlarmSeverity, AckBatch, AckBatchItem } from './types'

const store = useOpcuaStore()
const updateTimer = ref<number | null>(null)

// 展开的批次清单（新批次产生时自动展开）
const expandedBatches = ref<string[]>(
  store.ackBatches.filter(b => b.running || b.items.some(i => i.status === 'failed')).map(b => b.id)
)

const severityOptions: Array<{ value: AlarmSeverity; label: string }> = [
  { value: 'Critical', label: '严重' },
  { value: 'High', label: '高' },
  { value: 'Medium', label: '中' },
  { value: 'Low', label: '低' },
  { value: 'Info', label: '信息' }
]

const collapsedSeverities = computed(() => store.filter.collapsedGroups)

// 统计行的“严重”同样基于当前筛选结果
const criticalCount = computed(() =>
  store.filteredAlarms.filter(a => a.severity === 'Critical' && !a.acknowledged).length
)

function groupActiveItems(group: { items: AlarmEvent[] }) {
  return group.items.filter(a => !a.acknowledged)
}

function failedItems(batch: AckBatch): AckBatchItem[] {
  return batch.items.filter(i => i.status === 'failed')
}

function resetFilter() {
  store.setSeverityFilter([])
  store.setStatusFilter('all')
  store.setKeywordFilter('')
}

function handleBatchAck() {
  const count = store.activeFilteredAlarms.length
  if (count === 0) return
  const batch = store.acknowledgeAlarmsBatch()
  if (!batch) {
    ElMessage.warning('已有批量确认正在执行，请等待完成')
    return
  }
  expandedBatches.value.push(batch.id)
  ElMessage.info(`开始批量确认 ${count} 条报警`)
}

function handleGroupAck(severity: AlarmSeverity) {
  const group = store.groupedAlarms.find(g => g.severity === severity)
  if (!group) return
  const ids = group.items.filter(a => !a.acknowledged).map(a => a.id)
  if (ids.length === 0) return
  const batch = store.acknowledgeAlarmsBatch(ids, 'severity-group')
  if (!batch) {
    ElMessage.warning('已有批量确认正在执行，请等待完成')
    return
  }
  expandedBatches.value.push(batch.id)
  ElMessage.info(`开始确认「${getSeverityLabel(severity)}」组 ${ids.length} 条报警`)
}

async function handleClear() {
  if (store.alarms.length === 0) return
  try {
    await ElMessageBox.confirm(
      `将清空全部 ${store.alarms.length} 条报警与待处理清单，且不可恢复。是否继续？`,
      '清空报警',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
    )
    store.clearAlarms()
    ElMessage.success('报警已清空')
  } catch {
    // 用户取消
  }
}

function toggleConnection() {
  if (store.isConnected) {
    store.disconnect()
    if (updateTimer.value) {
      clearInterval(updateTimer.value)
      updateTimer.value = null
    }
    ElMessage.warning('已断开 OPC-UA 连接')
  } else {
    store.connect()
    startSimulation()
    ElMessage.success('已连接 OPC-UA 服务器')
  }
}

function startSimulation() {
  updateTimer.value = window.setInterval(() => {
    store.simulateDataUpdate()
  }, 1000)
}

function getSeverityType(severity: AlarmSeverity) {
  switch (severity) {
    case 'Critical': return 'danger'
    case 'High': return 'danger'
    case 'Medium': return 'warning'
    case 'Low': return 'info'
    case 'Info': return 'info'
  }
}

function getSeverityLabel(severity: AlarmSeverity) {
  switch (severity) {
    case 'Critical': return '严重'
    case 'High': return '高'
    case 'Medium': return '中'
    case 'Low': return '低'
    case 'Info': return '信息'
  }
}

function batchStatusLabel(batch: AckBatch): string {
  const failed = store.batchItemCount(batch, 'failed')
  if (batch.running) return '确认中'
  if (failed > 0) return failed === batch.items.length ? '全部失败' : '部分失败'
  return '已完成'
}

function batchStatusType(batch: AckBatch): 'primary' | 'success' | 'warning' | 'danger' | 'info' {
  if (batch.running) return 'primary'
  const failed = store.batchItemCount(batch, 'failed')
  if (failed === batch.items.length) return 'danger'
  if (failed > 0) return 'warning'
  return 'success'
}

function itemStatusLabel(item: AckBatchItem): string {
  switch (item.status) {
    case 'pending': return '等待中'
    case 'processing': return '确认中…'
    case 'success': return `已确认${item.attempts > 1 ? `（重试第 ${item.attempts} 次成功）` : ''}`
    case 'failed': return `${item.error ?? '失败'} · 第 ${item.attempts} 次`
  }
}

function describeBatchScope(batch: AckBatch): string {
  const parts: string[] = []
  parts.push(batch.source === 'severity-group' ? '按严重程度组确认' : '批量确认')
  parts.push(
    batch.filter.severities.length > 0
      ? batch.filter.severities.map(getSeverityLabel).join('/')
      : '全部严重程度'
  )
  parts.push(batch.filter.status === 'active' ? '未确认' : batch.filter.status === 'acknowledged' ? '已确认' : '全部状态')
  if (batch.filter.keyword) parts.push(`关键词「${batch.filter.keyword}」`)
  return parts.join(' · ')
}

function findAckBatch(alarm: AlarmEvent): AckBatch | undefined {
  return alarm.ackBatchId
    ? store.ackBatches.find(b => b.id === alarm.ackBatchId)
    : undefined
}

function ackSourceLabel(alarm: AlarmEvent): string {
  const batch = findAckBatch(alarm)
  return batch ? `批量#${batch.seq}确认` : '手动确认'
}

function ackSourceTooltip(alarm: AlarmEvent): string {
  const batch = findAckBatch(alarm)
  if (!batch) return '手动单条确认'
  return `由待处理清单 #${batch.seq} 批量操作确认（${formatTime(batch.createdAt)}）`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

// 新批次入清单时自动展开
watch(
  () => store.ackBatches.length,
  () => {
    store.ackBatches.forEach(batch => {
      if (
        (batch.running || store.batchItemCount(batch, 'failed') > 0) &&
        !expandedBatches.value.includes(batch.id)
      ) {
        expandedBatches.value.push(batch.id)
      }
    })
  }
)

onMounted(() => {
  store.connect()
  startSimulation()
})

onUnmounted(() => {
  if (updateTimer.value) {
    clearInterval(updateTimer.value)
  }
})
</script>

<style scoped>
.app-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0f172a;
  overflow: hidden;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 56px;
  background: rgba(15, 23, 42, 0.95);
  border-bottom: 1px solid rgba(71, 85, 105, 0.5);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-title {
  font-size: 18px;
  font-weight: bold;
  background: linear-gradient(90deg, #06b6d4, #22d3ee);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.count-tag {
  font-variant-numeric: tabular-nums;
}

.status-tag {
  display: flex;
  align-items: center;
  gap: 4px;
}

.app-main {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.left-panel {
  width: 320px;
  background: rgba(30, 41, 59, 0.6);
  border-right: 1px solid rgba(71, 85, 105, 0.5);
  overflow-y: auto;
  flex-shrink: 0;
}

.center-panel {
  flex: 1;
  overflow-y: auto;
  background: #0f172a;
}

.right-panel {
  width: 380px;
  background: rgba(30, 41, 59, 0.6);
  border-left: 1px solid rgba(71, 85, 105, 0.5);
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}

.alarm-panel {
  padding: 12px;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.alarm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.alarm-stats {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.filter-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(71, 85, 105, 0.4);
  border-radius: 6px;
  margin-bottom: 10px;
}

.filter-select,
.filter-status,
.filter-keyword {
  width: 100%;
}

.filter-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.filter-actions .el-button {
  margin-left: 0;
}

.alarm-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 6px;
}

.section-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: 11px;
  border-radius: 9px;
  background: rgba(71, 85, 105, 0.6);
  color: #cbd5e1;
}

.pending-section {
  margin-bottom: 12px;
}

.batch-collapse {
  border: none;
}

.batch-collapse :deep(.el-collapse-item__header) {
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(71, 85, 105, 0.4);
  border-radius: 6px;
  padding: 0 8px;
  margin-bottom: 6px;
}

.batch-collapse :deep(.el-collapse-item__wrap) {
  border: none;
}

.batch-title {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

.batch-meta {
  font-size: 11px;
  color: #94a3b8;
  white-space: nowrap;
}

.batch-time {
  margin-left: auto;
  font-size: 11px;
  color: #64748b;
  font-family: monospace;
  padding-right: 8px;
}

.batch-body {
  padding: 4px 0 8px;
}

.batch-scope {
  font-size: 11px;
  color: #64748b;
  margin-bottom: 6px;
}

.batch-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px dashed rgba(71, 85, 105, 0.3);
}

.batch-item-name {
  color: #cbd5e1;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-item-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #94a3b8;
  font-size: 11px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-item-success .batch-item-status {
  color: #4ade80;
}

.batch-item-failed .batch-item-status {
  color: #f87171;
}

.batch-item-processing .batch-item-status {
  color: #38bdf8;
}

.batch-item-attempts {
  font-size: 10px;
  color: #64748b;
}

.batch-errors {
  margin: 4px 0;
  padding: 6px 8px;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 4px;
}

.batch-error {
  font-size: 11px;
  color: #fca5a5;
}

.batch-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

.alarm-group {
  margin-bottom: 8px;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(15, 23, 42, 0.7);
  border: 1px solid rgba(71, 85, 105, 0.4);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}

.group-caret {
  color: #94a3b8;
}

.group-count {
  font-size: 12px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.group-header .el-button {
  margin-left: auto;
}

.group-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 0 4px 6px;
}

.group-empty {
  font-size: 11px;
  color: #475569;
  padding: 4px 0 8px;
}

.alarm-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.alarm-item {
  background: rgba(30, 41, 59, 0.8);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-radius: 6px;
  padding: 10px;
  border-left: 3px solid #64748b;
}

.alarm-critical {
  border-left-color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.alarm-high {
  border-left-color: #f97316;
  background: rgba(249, 115, 22, 0.05);
}

.alarm-medium {
  border-left-color: #eab308;
  background: rgba(234, 179, 8, 0.05);
}

.alarm-low {
  border-left-color: #38bdf8;
}

.alarm-info {
  border-left-color: #64748b;
}

.alarm-acknowledged {
  opacity: 0.55;
}

.alarm-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.alarm-time {
  font-size: 11px;
  color: #64748b;
  font-family: monospace;
}

.alarm-node {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 500;
}

.alarm-message {
  font-size: 13px;
  color: #cbd5e1;
  margin-top: 4px;
}

.alarm-item-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 2px;
}

.ack-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.no-alarms {
  display: flex;
  justify-content: center;
  padding-top: 40px;
}

.alarm-badge {
  cursor: pointer;
}
</style>
