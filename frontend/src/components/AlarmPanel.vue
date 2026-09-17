<template>
  <div class="alarm-panel">
    <div class="alarm-header">
      <h3 class="text-lg font-bold text-yellow-400">报警事件</h3>
      <el-button
        type="danger"
        size="small"
        text
        :disabled="batchRunning"
        @click="handleClear"
      >
        清空
      </el-button>
    </div>

    <!-- 统计：与下方筛选后条目同源 -->
    <div class="alarm-stats">
      <el-tag type="danger" size="small">严重: {{ store.viewCriticalCount }}</el-tag>
      <el-tag type="warning" size="small">活跃: {{ store.viewActiveCount }}</el-tag>
      <el-tag type="info" size="small">总计: {{ store.viewTotalCount }}</el-tag>
    </div>
    <div
      v-if="store.isFilterActive && store.alarms.length > 0"
      class="alarm-stats-global"
    >
      全部报警中共 {{ store.activeAlarmsCount }} 条活跃 / {{ store.alarms.length }} 条
    </div>

    <!-- 筛选条件（刷新后保持） -->
    <div class="alarm-filters">
      <el-radio-group
        :model-value="store.alarmFilter.status"
        size="small"
        @update:model-value="store.setStatusFilter"
      >
        <el-radio-button value="unacknowledged">未确认</el-radio-button>
        <el-radio-button value="acknowledged">已确认</el-radio-button>
        <el-radio-button value="all">全部</el-radio-button>
      </el-radio-group>

      <div class="severity-filter">
        <el-tag
          v-for="severity in SEVERITIES"
          :key="severity"
          :type="getSeverityType(severity)"
          size="small"
          :effect="severitySelected(severity) ? 'dark' : 'plain'"
          class="severity-tag"
          @click="store.toggleSeverityFilter(severity)"
        >
          {{ getSeverityLabel(severity) }}
        </el-tag>
      </div>

      <el-input
        :model-value="store.alarmFilter.keyword"
        size="small"
        placeholder="搜索节点 / 报警内容"
        clearable
        @update:model-value="store.setKeyword"
      />

      <el-button
        v-if="store.isFilterActive"
        size="small"
        text
        type="primary"
        @click="store.resetFilter"
      >
        重置筛选
      </el-button>
    </div>

    <!-- 批量操作工具栏 -->
    <div class="alarm-toolbar">
      <el-button
        type="primary"
        size="small"
        :loading="batchRunning"
        :disabled="store.viewActiveCount === 0"
        @click="handleAckView"
      >
        批量确认 ({{ store.viewActiveCount }})
      </el-button>
      <el-button
        v-if="store.retryableBatch"
        type="warning"
        size="small"
        :loading="batchRunning"
        @click="handleRetryFailed"
      >
        重试失败 ({{ failedIdsOfRetryable.length }})
      </el-button>
      <span v-if="store.activeBatch" class="batch-progress">
        正在逐条确认…
        {{ store.activeBatch.succeeded + store.activeBatch.failed }}/{{ store.activeBatch.total }}
      </span>
    </div>

    <!-- 按严重程度分组 -->
    <div class="alarm-list">
      <div v-for="group in store.groupedAlarms" :key="group.severity" class="alarm-group">
        <div class="alarm-group-header" @click="store.toggleGroupCollapsed(group.severity)">
          <el-icon class="collapse-icon">
            <ArrowDown v-if="!isCollapsed(group.severity)" />
            <ArrowRight v-else />
          </el-icon>
          <el-tag :type="getSeverityType(group.severity)" size="small" effect="dark">
            {{ getSeverityLabel(group.severity) }}
          </el-tag>
          <span class="group-count">{{ group.items.length }}</span>
          <el-button
            type="primary"
            size="small"
            text
            class="group-ack-btn"
            :loading="batchRunning"
            :disabled="unackCount(group.items) === 0"
            @click.stop="handleAckGroup(group.severity)"
          >
            确认本组 ({{ unackCount(group.items) }})
          </el-button>
        </div>

        <template v-if="!isCollapsed(group.severity)">
          <div
            v-for="alarm in group.items"
            :key="alarm.id"
            class="alarm-item"
            :class="{
              'alarm-critical': alarm.severity === 'Critical',
              'alarm-high': alarm.severity === 'High',
              'alarm-medium': alarm.severity === 'Medium',
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

            <!-- 批量确认过程中/结束后的逐条结果 -->
            <div v-if="getItemState(alarm.id)?.status === 'processing'" class="alarm-item-result processing">
              <el-icon class="is-loading"><Loading /></el-icon>
              确认中…（第 {{ getItemState(alarm.id)?.attempts }} 次尝试）
            </div>
            <div v-else-if="getItemState(alarm.id)?.status === 'failed'" class="alarm-item-result failed">
              <span class="result-error">
                <el-icon><WarningFilled /></el-icon>
                {{ getItemState(alarm.id)?.error || '确认失败' }}
              </span>
              <el-button
                type="warning"
                size="small"
                text
                :loading="batchRunning"
                @click="handleRetryItem(alarm.id)"
              >
                重试
              </el-button>
            </div>

            <!-- 未确认：原有的单条确认入口保持不变 -->
            <el-button
              v-else-if="!alarm.acknowledged"
              type="primary"
              size="small"
              text
              @click="store.acknowledgeAlarm(alarm.id)"
            >
              确认
            </el-button>

            <!-- 已确认：可回看，并标明确认来源批次 -->
            <div v-else class="alarm-item-result acknowledged">
              <el-tooltip
                v-if="alarm.ackBatchId"
                :content="batchTooltip(alarm.ackBatchId)"
                placement="top"
              >
                <el-tag type="success" size="small">
                  批量确认 · {{ batchLabel(alarm.ackBatchId) }}
                </el-tag>
              </el-tooltip>
              <el-tag v-else type="info" size="small">单条确认</el-tag>
              <span v-if="alarm.acknowledgedAt" class="ack-time">
                {{ formatTime(alarm.acknowledgedAt) }}
              </span>
            </div>
          </div>
        </template>
      </div>

      <div v-if="store.groupedAlarms.length === 0" class="no-alarms">
        <el-empty :description="store.alarms.length === 0 ? '暂无报警' : '没有符合筛选条件的报警'" :image-size="60" />
        <el-button
          v-if="store.alarms.length > 0 && store.isFilterActive"
          size="small"
          @click="store.resetFilter"
        >
          清除筛选条件
        </el-button>
      </div>
    </div>

    <!-- 批量操作记录 -->
    <div v-if="store.ackBatches.length > 0" class="batch-history">
      <div class="batch-history-header" @click="historyExpanded = !historyExpanded">
        <el-icon>
          <ArrowDown v-if="historyExpanded" />
          <ArrowRight v-else />
        </el-icon>
        <span>批量操作记录 ({{ store.ackBatches.length }})</span>
      </div>
      <div v-if="historyExpanded" class="batch-history-list">
        <div
          v-for="batch in store.ackBatches"
          :key="batch.id"
          class="batch-history-item"
          :class="{ running: batch.status === 'running' }"
        >
          <div class="batch-history-main">
            <el-tag :type="batch.failed > 0 ? 'warning' : 'success'" size="small">
              {{ scopeLabel(batch.scope, batch.severity) }}
            </el-tag>
            <span class="batch-history-time">{{ formatTime(batch.createdAt) }}</span>
          </div>
          <div class="batch-history-detail">
            共 {{ batch.total }} 条 · 成功 {{ batch.succeeded }} · 失败 {{ batch.failed }}
            <template v-if="batch.attempts > 1"> · 已重试 {{ batch.attempts - 1 }} 轮</template>
            <el-button
              v-if="failedIds(batch.id).length > 0 && !batchRunning"
              type="warning"
              size="small"
              text
              @click="handleRetryBatch(batch.id)"
            >
              重试失败 ({{ failedIds(batch.id).length }})
            </el-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowDown,
  ArrowRight,
  Loading,
  WarningFilled
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useOpcuaStore } from '../store/opcua'
import type { AlarmEvent, AlarmSeverity } from '../types'

const store = useOpcuaStore()

const SEVERITIES: AlarmSeverity[] = ['Critical', 'High', 'Medium', 'Low', 'Info']

const historyExpanded = ref(false)

const batchRunning = computed(() => store.activeBatchId !== null)

function severitySelected(severity: AlarmSeverity) {
  return store.alarmFilter.severities.includes(severity)
}

function isCollapsed(severity: AlarmSeverity) {
  return store.collapsedGroups.includes(severity)
}

function unackCount(items: AlarmEvent[]) {
  return items.filter(a => !a.acknowledged).length
}

function getItemState(alarmId: string) {
  return store.itemAckStates[alarmId]
}

function failedIds(batchId: string) {
  return store.getBatchFailedIds(batchId)
}

const failedIdsOfRetryable = computed(() =>
  store.retryableBatch ? store.getBatchFailedIds(store.retryableBatch.id) : []
)

async function handleAckView() {
  const batch = await store.acknowledgeAlarms('view')
  if (batch) reportResult(batch)
}

async function handleAckGroup(severity: AlarmSeverity) {
  const batch = await store.acknowledgeAlarms('severity', severity)
  if (batch) reportResult(batch)
}

async function handleRetryFailed() {
  if (!store.retryableBatch) return
  const batch = await store.retryBatch(store.retryableBatch.id)
  if (batch) reportResult(batch)
}

async function handleRetryBatch(batchId: string) {
  const batch = await store.retryBatch(batchId)
  if (batch) reportResult(batch)
}

async function handleRetryItem(alarmId: string) {
  await store.retryItem(alarmId)
  const state = store.itemAckStates[alarmId]
  if (state?.status === 'success') ElMessage.success('该条目已确认')
  else if (state?.status === 'failed') ElMessage.error(state.error || '确认失败，请重试')
}

function reportResult(batch: { total: number; succeeded: number; failed: number }) {
  if (batch.failed === 0) {
    ElMessage.success(`批量确认完成：${batch.succeeded}/${batch.total} 条成功`)
  } else {
    ElMessage.warning(`批量确认结束：成功 ${batch.succeeded} 条，${batch.failed} 条失败，可在列表中重试`)
  }
}

async function handleClear() {
  try {
    await ElMessageBox.confirm('确定清空全部报警吗？此操作不可恢复。', '清空报警', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  store.clearAlarms()
  ElMessage.success('报警已清空')
}

function batchLabel(batchId: string) {
  const batch = store.ackBatches.find(b => b.id === batchId)
  const suffix = batchId.slice(-6)
  return batch ? `${formatTime(batch.createdAt)} #${suffix}` : `#${suffix}`
}

function scopeLabel(scope: 'view' | 'severity', severity: AlarmSeverity | null) {
  return scope === 'view' ? '筛选批量确认' : `本组确认(${getSeverityLabel(severity ?? 'Info')})`
}

function batchTooltip(batchId: string) {
  const batch = store.ackBatches.find(b => b.id === batchId)
  if (!batch) return `批次 ${batchId}`
  return `${scopeLabel(batch.scope, batch.severity)} · 共 ${batch.total} 条 · 成功 ${batch.succeeded} · 失败 ${batch.failed} · 已重试 ${batch.attempts - 1} 轮`
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

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<style scoped>
.alarm-panel {
  padding: 12px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.alarm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.alarm-stats {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.alarm-stats-global {
  font-size: 11px;
  color: #64748b;
  margin-bottom: 10px;
}

.alarm-filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(71, 85, 105, 0.4);
  border-radius: 6px;
  margin-bottom: 8px;
}

.severity-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.severity-tag {
  cursor: pointer;
  user-select: none;
}

.alarm-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.batch-progress {
  font-size: 11px;
  color: #38bdf8;
}

.alarm-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 80px;
}

.alarm-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.alarm-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: rgba(51, 65, 85, 0.4);
  border-radius: 4px;
  cursor: pointer;
  position: sticky;
  top: 0;
  z-index: 1;
}

.collapse-icon {
  color: #94a3b8;
}

.group-count {
  font-size: 12px;
  color: #cbd5e1;
  font-weight: 600;
}

.group-ack-btn {
  margin-left: auto;
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

.alarm-item-result {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.alarm-item-result.processing {
  color: #38bdf8;
}

.alarm-item-result.failed {
  justify-content: space-between;
}

.result-error {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #f87171;
}

.alarm-item-result.acknowledged {
  justify-content: flex-start;
  flex-wrap: wrap;
}

.ack-time {
  font-size: 11px;
  color: #64748b;
  font-family: monospace;
}

.no-alarms {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 30px;
}

.batch-history {
  border-top: 1px solid rgba(71, 85, 105, 0.4);
  margin-top: 8px;
  padding-top: 6px;
  flex-shrink: 0;
  max-height: 35%;
  display: flex;
  flex-direction: column;
}

.batch-history-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px 0;
}

.batch-history-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.batch-history-item {
  background: rgba(15, 23, 42, 0.6);
  border-radius: 4px;
  padding: 6px 8px;
}

.batch-history-item.running {
  outline: 1px solid rgba(56, 189, 248, 0.4);
}

.batch-history-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.batch-history-time {
  font-size: 11px;
  color: #64748b;
  font-family: monospace;
}

.batch-history-detail {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 4px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
