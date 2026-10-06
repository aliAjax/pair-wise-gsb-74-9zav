/* 供 verify-revision.cjs 打包调用的场景入口（Node 环境，内存 localStorage） */
import type {
  GovernanceState,
  PendingOperation,
  PlatformRule,
  ReleaseCandidate,
} from '@/models/domain'
import { createSeedState } from '@/models/seed'
import {
  appendPendingOperation,
  clearPendingOperation,
  loadPendingOperations,
  loadState,
  resetState,
  saveState,
} from '@/services/repository'
import {
  applyRollback,
  recordContractRevision,
  releaseGateIssues,
  recoverPendingOperations,
} from '@/services/revision'
import { freezeReleaseEvidence } from '@/services/revision'

const memoryStore = new Map<string, string>()
;(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key: string, value: string) => void memoryStore.set(key, String(value)),
  removeItem: (key: string) => void memoryStore.delete(key),
  clear: () => memoryStore.clear(),
  key: (index: number) => [...memoryStore.keys()][index] ?? null,
  get length() {
    return memoryStore.size
  },
} as Storage

const freshState = (): GovernanceState => structuredClone(resetState())

const editPlatformRule = (
  state: GovernanceState,
  eventId: string,
  ruleId: string,
  trigger: string,
): void => {
  const event = state.events.find((item) => item.id === eventId)
  const rule = event?.platformRules.find((item) => item.id === ruleId)
  if (!event || !rule) throw new Error('rule not found')
  rule.trigger = trigger
  event.updatedAt = new Date().toISOString()
  recordContractRevision(state, {
    source: 'platform_rule',
    entityId: rule.id,
    eventId,
    summary: `${event.key}/${rule.platform}：${trigger}`,
    detail: trigger,
    actor: '测试窗口',
    createdAt: event.updatedAt,
  })
}

const gate = (release: ReleaseCandidate) => releaseGateIssues(release)

const reconfirmAll = (state: GovernanceState, release: ReleaseCandidate): void => {
  release.migrationConfirmations.forEach((confirmation) => {
    confirmation.status = 'confirmed'
    confirmation.revision = state.headRevision
    confirmation.invalidatedRevision = undefined
    confirmation.invalidatedReason = undefined
    confirmation.previousStatus = undefined
    confirmation.confirmedAt = new Date().toISOString()
    const dep = state.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dep) dep.status = 'migrated'
  })
  release.approvals.forEach((approval) => {
    approval.status = 'approved'
    approval.revision = state.headRevision
    approval.invalidatedRevision = undefined
    approval.invalidatedReason = undefined
    approval.previousStatus = undefined
    approval.createdAt = new Date().toISOString()
  })
  release.staleReason = undefined
}

const stagePublish = (state: GovernanceState, releaseId: string): PendingOperation => {
  const release = state.releases.find((item) => item.id === releaseId)
  if (!release) throw new Error('release not found')
  const operation: PendingOperation = {
    operationId: `op-publish-${releaseId}`,
    type: 'publish',
    intendedRevision: state.headRevision,
    createdAt: new Date().toISOString(),
    candidate: structuredClone(release),
  }
  appendPendingOperation(operation)
  return operation
}

const publishViaWal = (
  state: GovernanceState,
  releaseId: string,
): { result: { cleared: boolean; operation: PendingOperation }; baselinesBefore: number } => {
  const operation = stagePublish(state, releaseId)
  const release = state.releases.find((item) => item.id === releaseId)!
  const baselinesBefore = state.baselines.length
  const frozenAt = new Date().toISOString()
  release.status = 'published'
  release.publishedAt = frozenAt
  freezeReleaseEvidence(release, operation.intendedRevision, frozenAt, operation.operationId)
  release.eventIds.forEach((eventId) => {
    state.baselines.unshift({
      id: `base-${release.id}-${eventId}`,
      eventId,
      version: state.events.find((event) => event.id === eventId)?.version ?? '0',
      properties: structuredClone(
        state.events.find((event) => event.id === eventId)?.properties ?? [],
      ),
      createdAt: frozenAt,
      status: 'published',
    })
  })
  saveState(state)
  clearPendingOperation(operation.operationId)
  return { result: { cleared: loadPendingOperations().length === 0, operation }, baselinesBefore }
}

const replayPending = (state: GovernanceState, operation: PendingOperation): void => {
  appendPendingOperation(operation)
  recoverPendingOperations(state, loadPendingOperations())
  clearPendingOperation(operation.operationId)
}

const loadWithPending = (pending: PendingOperation[]): GovernanceState => {
  // 先保证存储中有一份基线状态，再注入 WAL 走真实启动恢复路径
  if (!memoryStore.has('eventrail-governance-v1')) {
    memoryStore.set('eventrail-governance-v1', JSON.stringify(createSeedState()))
  }
  memoryStore.set('eventrail-governance-pending-v1', JSON.stringify(pending))
  return loadState()
}

const rollback = (state: GovernanceState, releaseId: string) => {
  const release = state.releases.find((item) => item.id === releaseId)
  if (!release) throw new Error('release not found')
  const operationId = `op-rollback-${releaseId}`
  const record = applyRollback(state, {
    releaseId,
    reason: '演练回滚',
    scope: '全端',
    evidence: 'RB-TEST',
    operator: '测试人',
    operationId,
  })
  if (!record) throw new Error('rollback failed')
  return record
}

const tryCommit = (base: GovernanceState, next: GovernanceState): { ok: boolean; conflict: boolean } => {
  try {
    saveState(next, next.stateVersion)
    Object.assign(base, next)
    return { ok: true, conflict: false }
  } catch (error) {
    return {
      ok: false,
      conflict: (error as { name?: string }).name === 'RevisionConflictError',
    }
  }
}

export {
  freshState,
  editPlatformRule,
  gate,
  reconfirmAll,
  stagePublish,
  publishViaWal,
  replayPending,
  loadWithPending,
  rollback,
  tryCommit,
}
