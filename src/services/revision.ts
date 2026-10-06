import type {
  ContractRevision,
  DownstreamDependency,
  EventDefinition,
  FrozenEvidence,
  GovernanceState,
  MigrationConfirmation,
  PendingOperation,
  ReleaseCandidate,
  RollbackRecord,
  RollbackReconciliationItem,
} from '@/models/domain'
import { createId } from '@/services/ids'
import {
  affectedDependencies,
  contractDifferences,
  latestBaseline,
} from '@/services/selectors'

/** 一次契约修订的输入：事件、属性或平台规则变化共用同一条修订号 */
export interface ContractChangeInput {
  source: ContractRevision['source']
  entityId: string
  eventId: string
  summary: string
  detail: string
  actor: string
  createdAt: string
}

export interface GateIssue {
  kind:
    | 'stale_confirmation'
    | 'pending_confirmation'
    | 'stale_approval'
    | 'pending_approval'
    | 'scope_stale'
  targetId: string
  label: string
  reason: string
}

const ACTIVE_RELEASE: ReadonlySet<ReleaseCandidate['status']> = new Set(['reviewing', 'draft'])

const markScopeStale = (release: ReleaseCandidate, revision: number, summary: string): void => {
  release.staleReason = {
    revision,
    scopeStale: true,
    reason: `契约已推进到 r${revision}（${summary}），候选仍停留在 r${release.scopeRevision}，需同步当前修订并重新核对。`,
  }
}

const invalidateConfirmation = (
  confirmation: MigrationConfirmation,
  revision: number,
  reason: string,
): void => {
  if (confirmation.status === 'rejected' || confirmation.status === 'pending') return
  if (confirmation.status === 'confirmed') confirmation.previousStatus = 'confirmed'
  confirmation.status = 'invalidated'
  // 已失效的证据再次被更新修订波及时，刷新到最新失效修订与原因
  confirmation.invalidatedRevision = revision
  confirmation.invalidatedReason = reason
}

const invalidateApproval = (
  approval: ReleaseCandidate['approvals'][number],
  revision: number,
  reason: string,
): void => {
  if (approval.status === 'rejected' || approval.status === 'pending') return
  if (approval.status === 'approved') approval.previousStatus = 'approved'
  approval.status = 'invalidated'
  approval.invalidatedRevision = revision
  approval.invalidatedReason = reason
}

/**
 * 让所有相交的进行中候选失效：
 * - 候选事件范围命中变化事件时，已通过的四角色审批全部失效；
 * - 受变化影响的下游依赖，其迁移确认全部失效；
 * - 新出现的受影响下游自动补入待核对清单。
 */
const applyStaleness = (
  state: GovernanceState,
  revisionEntry: ContractRevision,
  scopeEventIds: string[],
  affectedDependencyIds: string[],
  recomputeScope: boolean,
): void => {
  const reason =
    revisionEntry.kind === 'rollback'
      ? `回滚修订 r${revisionEntry.revision}：${revisionEntry.summary}`
      : `契约修订 r${revisionEntry.revision}：${revisionEntry.summary}`

  state.releases.forEach((release) => {
    if (!ACTIVE_RELEASE.has(release.status)) return
    const scopeOverlap = release.eventIds.some((eventId) => scopeEventIds.includes(eventId))
    if (!scopeOverlap) return

    release.approvals.forEach((approval) => invalidateApproval(approval, revisionEntry.revision, reason))
    release.migrationConfirmations.forEach((confirmation) => {
      if (affectedDependencyIds.includes(confirmation.dependencyId)) {
        invalidateConfirmation(confirmation, revisionEntry.revision, reason)
      }
    })

    if (recomputeScope) {
      release.differences = contractDifferences(state, release.eventIds)
      const recomputed = new Set([
        ...affectedDependencies(state, release.differences),
        ...affectedDependencyIds,
      ])
      recomputed.forEach((dependencyId) => {
        if (!release.affectedDependencyIds.includes(dependencyId)) {
          release.affectedDependencyIds.push(dependencyId)
          release.migrationConfirmations.push({
            id: createId('mig'),
            dependencyId,
            version: release.version,
            status: 'pending',
            reviewer:
              state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
            note: '',
          })
        }
      })
    }

    release.scopeRevision = revisionEntry.revision
    // 相交候选已纳入本次修订差异，消除“落后于当前修订”标记
    release.staleReason = undefined
  })

  // 不相交的进行中候选：没有证据失效，但候选差异已落后于当前修订
  state.releases.forEach((release) => {
    if (!ACTIVE_RELEASE.has(release.status)) return
    if (release.eventIds.some((eventId) => scopeEventIds.includes(eventId))) return
    markScopeStale(release, revisionEntry.revision, revisionEntry.summary)
  })
}

/** 推进一个契约修订号，写入台账并传播失效 */
export const recordContractRevision = (
  state: GovernanceState,
  input: ContractChangeInput,
): ContractRevision => {
  const revision = state.headRevision + 1
  const entry: ContractRevision = {
    revision,
    kind: 'contract',
    source: input.source,
    entityId: input.entityId,
    eventId: input.eventId,
    summary: input.summary,
    detail: input.detail,
    actor: input.actor,
    createdAt: input.createdAt,
  }
  state.revisions.push(entry)
  state.headRevision = revision

  // 属性/删除变化按字段引用计算；事件或平台规则变化影响所有消费该事件的下游
  const affected =
    input.source === 'property'
      ? affectedDependencies(state, contractDifferences(state, [input.eventId]))
      : state.dependencies
          .filter((dependency) => dependency.eventIds.includes(input.eventId))
          .map((dependency) => dependency.id)
  applyStaleness(state, entry, [input.eventId], affected, true)
  return entry
}

/** 按当前契约重新计算下游依赖的迁移状态（回滚后对账） */
export const reconcileDependencyStatus = (
  state: GovernanceState,
  scopeEventIds: string[],
): RollbackReconciliationItem[] => {
  const items: RollbackReconciliationItem[] = []
  state.dependencies.forEach((dependency) => {
    if (dependency.status === 'disabled') return
    const touchedRefs = dependency.propertyRefs.filter((reference) =>
      scopeEventIds.includes(reference.eventId),
    )
    if (touchedRefs.length === 0) return

    const broken = touchedRefs.some((reference) => {
      const event = state.events.find((item) => item.id === reference.eventId)
      const property = event?.properties.find((item) => item.id === reference.propertyId)
      return !property || Boolean(property.deletedAt)
    })

    const nextStatus: DownstreamDependency['status'] = broken ? 'migration_required' : 'active'
    const matched = !broken
    const detail = broken
      ? '回滚后的契约仍缺少其引用的属性，需要继续迁移核对。'
      : '回滚后的契约与其字段引用核对一致。'

    items.push({
      dependencyId: dependency.id,
      dependencyName: dependency.name,
      status: nextStatus,
      matched,
      detail,
    })
    dependency.status = nextStatus
  })
  return items
}

export interface RollbackInput {
  releaseId: string
  reason: string
  scope: string
  evidence: string
  operator: string
  operationId: string
  /** WAL 恢复时沿用的修订号；正常执行时取 headRevision + 1 */
  intendedRevision?: number
}

/**
 * 执行回滚：共用同一个修订号序列，保留当前候选，
 * 相交候选的旧确认/审批失效，下游迁移状态按回滚后契约重新对账。
 * 同一 operationId 重放直接返回既有记录，不重复生成。
 */
export const applyRollback = (
  state: GovernanceState,
  input: RollbackInput,
): RollbackRecord | null => {
  const existing = state.rollbacks.find((record) => record.operationId === input.operationId)
  if (existing) return existing

  const release = state.releases.find((item) => item.id === input.releaseId)
  if (!release) return null

  const revision = input.intendedRevision ?? state.headRevision + 1
  const reconciliation = reconcileDependencyStatus(state, release.eventIds)

  const record: RollbackRecord = {
    id: createId('rollback'),
    releaseId: input.releaseId,
    version: release.version,
    reason: input.reason,
    operator: input.operator,
    scope: input.scope,
    createdAt: new Date().toISOString(),
    status: 'executed',
    evidence: input.evidence,
    revision,
    reconciliation,
    operationId: input.operationId,
  }
  state.rollbacks.unshift(record)
  release.status = 'rolled_back'

  const ledgerEntry: ContractRevision = {
    revision,
    kind: 'rollback',
    source: 'rollback',
    entityId: record.id,
    summary: `回滚发布 ${release.version}`,
    detail: input.reason,
    actor: input.operator,
    createdAt: record.createdAt,
    rollbackId: record.id,
  }
  if (!state.revisions.some((item) => item.revision === revision)) {
    state.revisions.push(ledgerEntry)
  }
  state.headRevision = Math.max(state.headRevision, revision)

  // 当前候选保留；相交候选的确认与审批按回滚修订重新核对
  applyStaleness(
    state,
    ledgerEntry,
    release.eventIds,
    reconciliation.map((item) => item.dependencyId),
    false,
  )

  return record
}

/**
 * 候选同步到当前契约修订：重新比较差异、补全新受影响下游，
 * 清除“落后于当前修订”标记。已失效的确认/审批仍需重新核对。
 */
export const refreshReleaseScope = (
  state: GovernanceState,
  releaseId: string,
): ReleaseCandidate | null => {
  const release = state.releases.find((item) => item.id === releaseId)
  if (!release || !ACTIVE_RELEASE.has(release.status)) return release ?? null
  release.differences = contractDifferences(state, release.eventIds)
  const affected = new Set(affectedDependencies(state, release.differences))
  release.eventIds.forEach((eventId) => {
    state.dependencies
      .filter((dependency) => dependency.eventIds.includes(eventId))
      .forEach((dependency) => affected.add(dependency.id))
  })
  affected.forEach((dependencyId) => {
    if (!release.affectedDependencyIds.includes(dependencyId)) {
      release.affectedDependencyIds.push(dependencyId)
      release.migrationConfirmations.push({
        id: createId('mig'),
        dependencyId,
        version: release.version,
        status: 'pending',
        reviewer:
          state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })
    }
  })
  release.scopeRevision = state.headRevision
  release.staleReason = undefined
  return release
}

/** 发布门禁：返回所有阻止发布的失效/待办项 */
export const releaseGateIssues = (release: ReleaseCandidate): GateIssue[] => {
  if (release.status !== 'reviewing' && release.status !== 'draft') return []
  const issues: GateIssue[] = []

  if (release.staleReason?.scopeStale) {
    issues.push({
      kind: 'scope_stale',
      targetId: release.id,
      label: '候选落后于当前契约修订',
      reason: release.staleReason.reason,
    })
  }

  const affected = new Set(release.affectedDependencyIds)
  release.migrationConfirmations
    .filter((confirmation) => affected.has(confirmation.dependencyId))
    .forEach((confirmation) => {
      const name = confirmation.dependencyId
      if (confirmation.status === 'invalidated') {
        issues.push({
          kind: 'stale_confirmation',
          targetId: confirmation.id,
          label: `${name} 的迁移确认已失效`,
          reason: confirmation.invalidatedReason ?? '契约已发生修订，需要下游重新核对。',
        })
      } else if (confirmation.status !== 'confirmed') {
        issues.push({
          kind: 'pending_confirmation',
          targetId: confirmation.id,
          label: `${name} 尚未完成迁移确认`,
          reason: confirmation.note || '下游尚未按当前修订核对。',
        })
      }
    })

  release.approvals.forEach((approval) => {
    const roleLabel = { data: '数据', product: '产品', client: '客户端', qa: '测试' }[approval.role]
    if (approval.status === 'invalidated') {
      issues.push({
        kind: 'stale_approval',
        targetId: approval.id,
        label: `${roleLabel}负责人审批已失效`,
        reason: approval.invalidatedReason ?? '契约已发生修订，需要重新审批。',
      })
    } else if (approval.status !== 'approved') {
      issues.push({
        kind: 'pending_approval',
        targetId: approval.id,
        label: `${roleLabel}负责人尚未审批通过`,
        reason: approval.comment || '待提交审批意见。',
      })
    }
  })

  return issues
}

/** 发布时冻结当前修订与确认证据 */
export const freezeReleaseEvidence = (
  release: ReleaseCandidate,
  revision: number,
  frozenAt: string,
  operationId: string,
): FrozenEvidence => {
  release.frozenRevision = revision
  release.frozenOperationId = operationId
  release.frozenEvidence = {
    revision,
    frozenAt,
    migrationConfirmations: release.migrationConfirmations.map((confirmation) => ({
      dependencyId: confirmation.dependencyId,
      reviewer: confirmation.reviewer,
      note: confirmation.note,
      revision: confirmation.revision,
      confirmedAt: confirmation.confirmedAt,
    })),
    approvals: release.approvals.map((approval) => ({
      role: approval.role,
      actor: approval.actor,
      comment: approval.comment,
      revision: approval.revision,
      createdAt: approval.createdAt,
    })),
  }
  return release.frozenEvidence
}

const baselineIdFor = (releaseId: string, eventId: string): string => `base-${releaseId}-${eventId}`

/**
 * 启动时重放预写日志：从完整候选恢复发布/回滚。
 * 同一 operationId 已完成的记录不重复生成，同一修订重放保持幂等。
 */
export const recoverPendingOperations = (
  state: GovernanceState,
  pending: PendingOperation[],
): { recovered: PendingOperation[] } => {
  const recovered: PendingOperation[] = []

  pending.forEach((operation) => {
    if (operation.type === 'publish' && operation.candidate) {
      const snapshot = operation.candidate
      let release = state.releases.find((item) => item.id === snapshot.id)
      const alreadyFrozen = release?.frozenOperationId === operation.operationId

      if (!release) {
        // 候选本体也随写入失败丢失：从完整快照恢复
        release = structuredClone(snapshot)
        state.releases.unshift(release)
      }

      if (!alreadyFrozen) {
        release.status = 'published'
        release.publishedAt = release.publishedAt ?? operation.createdAt
        freezeReleaseEvidence(release, operation.intendedRevision, operation.createdAt, operation.operationId)
      }

      release.eventIds.forEach((eventId) => {
        const baselineId = baselineIdFor(release!.id, eventId)
        if (!state.baselines.some((baseline) => baseline.id === baselineId)) {
          const event = state.events.find((item) => item.id === eventId)
          if (event) {
            event.status = 'published'
            state.baselines.unshift({
              id: baselineId,
              eventId,
              version: event.version,
              properties: structuredClone(event.properties),
              createdAt: operation.createdAt,
              status: 'published',
            })
          }
        }
      })

      snapshot.migrationConfirmations
        .filter((confirmation) => confirmation.status === 'confirmed')
        .forEach((confirmation) => {
          const dependency = state.dependencies.find(
            (item) => item.id === confirmation.dependencyId,
          )
          if (dependency) dependency.status = 'migrated'
        })

      recovered.push(operation)
    }

    if (operation.type === 'rollback' && operation.releaseId) {
      const already = state.rollbacks.some(
        (record) => record.operationId === operation.operationId,
      )
      if (!already) {
        applyRollback(state, {
          releaseId: operation.releaseId,
          reason: operation.reason ?? '',
          scope: operation.scope ?? '',
          evidence: operation.evidence ?? '',
          operator: operation.operator ?? '当前用户',
          operationId: operation.operationId,
          intendedRevision: operation.intendedRevision,
        })
      }
      recovered.push(operation)
    }
  })

  return { recovered }
}

/** 供页面展示：事件最近一次契约修订 */
export const latestEventRevision = (
  state: GovernanceState,
  eventId: string,
): ContractRevision | undefined =>
  [...state.revisions]
    .reverse()
    .find((revision) => revision.kind === 'contract' && revision.eventId === eventId)

/** 当前生效基线（供导出展示修订对照） */
export const describeEventBaseline = (
  state: GovernanceState,
  event: EventDefinition,
): { version: string; revision?: number } => {
  const baseline = latestBaseline(state.baselines, event.id)
  const published = state.releases
    .filter((release) => release.status === 'published' && release.eventIds.includes(event.id))
    .sort((a, b) => (b.frozenRevision ?? 0) - (a.frozenRevision ?? 0))[0]
  return { version: baseline?.version ?? event.version, revision: published?.frozenRevision }
}
