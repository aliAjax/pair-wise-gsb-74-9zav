import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PendingOperation,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
} from '@/models/domain'
import {
  appendPendingOperation,
  clearPendingOperation,
  consumeRecoveryNotice,
  createId,
  loadState,
  onExternalState,
  resetState,
  RevisionConflictError,
  saveState,
} from '@/services/repository'
import {
  affectedDependencies,
  contractDifferences,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'
import {
  applyRollback,
  freezeReleaseEvidence,
  recordContractRevision,
  refreshReleaseScope,
  releaseGateIssues,
} from '@/services/revision'

export interface MutationResult {
  ok: boolean
  conflict: boolean
  message: string
}

const failure = (error: unknown): MutationResult => {
  if (error instanceof RevisionConflictError) {
    return { ok: false, conflict: true, message: error.message }
  }
  return { ok: false, conflict: false, message: error instanceof Error ? error.message : String(error) }
}

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  const recoveredOperations = ref<PendingOperation[]>(consumeRecoveryNotice())
  const lastConflictAt = ref<string | null>(null)

  const issues = computed(() => validateGovernance(data.value))

  onExternalState((latest) => {
    // 其他窗口已提交：以其更高 stateVersion 为新基准，迟到的本地修订因此无法覆盖
    if (latest.stateVersion > data.value.stateVersion) {
      data.value = latest
      lastSavedAt.value = new Date().toISOString()
    }
  })

  /**
   * 乐观并发提交。每个动作都对快照执行修改后 CAS 落盘：
   * 存储版本不匹配时抛出 RevisionConflictError，本次修改被丢弃并回退到最新状态。
   */
  const commit = (mutate: (state: GovernanceState) => void): MutationResult => {
    const snapshot = structuredClone(data.value)
    const expectedStateVersion = snapshot.stateVersion
    try {
      mutate(snapshot)
      saveState(snapshot, expectedStateVersion)
      data.value = snapshot
      lastSavedAt.value = new Date().toISOString()
      return { ok: true, conflict: false, message: '' }
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        data.value = error.latest
        lastSavedAt.value = new Date().toISOString()
        lastConflictAt.value = new Date().toISOString()
      }
      return failure(error)
    }
  }

  const addAudit = (
    state: GovernanceState,
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    state.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  const gateIssues = (release: ReleaseCandidate) => releaseGateIssues(release)

  const saveEvent = (event: EventDefinition): MutationResult =>
    commit((state) => {
      const index = state.events.findIndex((item) => item.id === event.id)
      const saved = { ...event, updatedAt: new Date().toISOString() }
      if (index >= 0) {
        state.events[index] = saved
      } else {
        state.events.unshift(saved)
      }
      const isNew = index < 0
      const revision = recordContractRevision(state, {
        source: 'event',
        entityId: event.id,
        eventId: event.id,
        summary: isNew ? `新建事件 ${event.key}` : `更新事件 ${event.key}`,
        detail: `${event.key} 事件契约已保存`,
        actor: '当前用户',
        createdAt: saved.updatedAt,
      })
      addAudit(
        state,
        'event',
        event.id,
        isNew ? '创建事件' : '更新事件',
        `${event.key} 契约已保存，修订号 r${revision.revision}`,
      )
    })

  const saveProperty = (eventId: string, property: EventProperty): MutationResult =>
    commit((state) => {
      const event = state.events.find((item) => item.id === eventId)
      if (!event) return
      const index = event.properties.findIndex((item) => item.id === property.id)
      if (index >= 0) {
        event.properties[index] = property
      } else {
        event.properties.push(property)
      }
      event.updatedAt = new Date().toISOString()
      const revision = recordContractRevision(state, {
        source: 'property',
        entityId: property.id,
        eventId,
        summary: index >= 0 ? `更新属性 ${event.key}.${property.name}` : `新增属性 ${event.key}.${property.name}`,
        detail: `${event.key}.${property.name} 契约修订`,
        actor: '当前用户',
        createdAt: event.updatedAt,
      })
      addAudit(
        state,
        'property',
        property.id,
        index >= 0 ? '更新属性' : '新增属性',
        `${event.key}.${property.name}（r${revision.revision}）`,
      )
    })

  const deleteProperty = (eventId: string, propertyId: string): MutationResult =>
    commit((state) => {
      const event = state.events.find((item) => item.id === eventId)
      const property = event?.properties.find((item) => item.id === propertyId)
      if (!event || !property) return
      property.deletedAt = new Date().toISOString()
      event.updatedAt = property.deletedAt
      const revision = recordContractRevision(state, {
        source: 'property',
        entityId: propertyId,
        eventId,
        summary: `删除属性 ${event.key}.${property.name}`,
        detail: `${event.key}.${property.name} 进入删除兼容期`,
        actor: '当前用户',
        createdAt: property.deletedAt,
      })
      addAudit(
        state,
        'property',
        propertyId,
        '标记删除',
        `${event.key}.${property.name} 进入删除兼容期（r${revision.revision}）`,
      )
    })

  const savePlatformRule = (eventId: string, rule: PlatformRule): MutationResult =>
    commit((state) => {
      const event = state.events.find((item) => item.id === eventId)
      if (!event) return
      const index = event.platformRules.findIndex((item) => item.id === rule.id)
      if (index >= 0) {
        event.platformRules[index] = rule
      } else {
        event.platformRules.push(rule)
      }
      event.updatedAt = new Date().toISOString()
      const revision = recordContractRevision(state, {
        source: 'platform_rule',
        entityId: rule.id,
        eventId,
        summary: `${index >= 0 ? '更新' : '新增'}平台规则 ${event.key}/${rule.platform}`,
        detail: `${event.key} 在 ${rule.platform} 的触发规则修订：${rule.trigger}`,
        actor: '当前用户',
        createdAt: event.updatedAt,
      })
      addAudit(
        state,
        'platform_rule',
        rule.id,
        index >= 0 ? '更新平台规则' : '新增平台规则',
        `${event.key}/${rule.platform}（r${revision.revision}）`,
      )
    })

  const createRelease = (
    version: string,
    title: string,
    eventIds: string[],
  ): { result: MutationResult; release?: ReleaseCandidate } => {
    let release: ReleaseCandidate | undefined
    const result = commit((state) => {
      const differences = contractDifferences(state, eventIds)
      const affected = affectedDependencies(state, differences)
      const created: ReleaseCandidate = {
        id: createId('rel'),
        version,
        title,
        status: 'reviewing',
        eventIds,
        affectedDependencyIds: affected,
        differences,
        migrationConfirmations: affected.map((dependencyId) => ({
          id: createId('mig'),
          dependencyId,
          version,
          status: 'pending',
          reviewer:
            state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
          note: '',
        })),
        approvals: [
          { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
          { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
          { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
          { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
        ],
        createdAt: new Date().toISOString(),
        // 候选钉在创建时的修订号上，之后的契约会使其确认/审批失效
        baseRevision: state.headRevision,
        scopeRevision: state.headRevision,
      }
      state.releases.unshift(created)
      state.currentVersion = version
      addAudit(
        state,
        'release',
        created.id,
        '创建发布候选',
        `${version}（基准修订 r${created.baseRevision}）包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖`,
      )
      release = created
    })
    return { result, release }
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): MutationResult =>
    commit((state) => {
      const release = state.releases.find((item) => item.id === releaseId)
      const confirmation = release?.migrationConfirmations.find(
        (item) => item.id === confirmationId,
      )
      if (!release || !confirmation) return
      confirmation.status = 'confirmed'
      confirmation.reviewer = reviewer
      confirmation.note = note
      confirmation.confirmedAt = new Date().toISOString()
      confirmation.revision = state.headRevision
      confirmation.invalidatedRevision = undefined
      confirmation.invalidatedReason = undefined
      confirmation.previousStatus = undefined
      const dependency = state.dependencies.find((item) => item.id === confirmation.dependencyId)
      if (dependency) dependency.status = 'migrated'
      addAudit(
        state,
        'dependency',
        confirmation.dependencyId,
        '确认迁移',
        `${reviewer} 按修订 r${state.headRevision} 重新核对：${note}`,
      )
    })

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): MutationResult =>
    commit((state) => {
      const release = state.releases.find((item) => item.id === releaseId)
      const approval = release?.approvals.find((item) => item.role === role)
      if (!release || !approval) return
      approval.status = status
      approval.actor = actor
      approval.comment = comment
      approval.createdAt = new Date().toISOString()
      if (status === 'approved') {
        approval.revision = state.headRevision
        approval.invalidatedRevision = undefined
        approval.invalidatedReason = undefined
        approval.previousStatus = undefined
      }
      addAudit(
        state,
        'release',
        releaseId,
        status === 'approved' ? '审批通过' : '审批驳回',
        `${role} 基于修订 r${state.headRevision}：${comment}`,
      )
    })

  const publishRelease = (releaseId: string): MutationResult => {
    // 1. 基于最新状态做门禁校验，并冻结快照与 WAL（在同一 CAS 事务内）
    const check = commit((state) => {
      const release = state.releases.find((item) => item.id === releaseId)
      if (!release) throw new Error('发布候选不存在')
      if (release.status === 'published' && release.frozenOperationId) {
        return // 幂等：同一候选已发布，直接视为成功
      }
      if (release.status !== 'reviewing' && release.status !== 'draft') {
        throw new Error('当前候选状态不允许发布')
      }
      if (releaseGateIssues(release).length > 0) {
        throw new Error('存在已失效或未完成的迁移确认/审批，请按当前修订重新核对后再发布')
      }
      const readiness = releaseReadiness(release, validateGovernance(state))
      if (readiness < 90) {
        throw new Error(`发布就绪度仅 ${readiness}%，未达到发布门禁`)
      }
    })
    if (!check.ok) return check

    // 2. 预写完整候选日志：之后任何写入失败都能从该快照恢复
    const operationId = `op-publish-${releaseId}`
    const current = data.value.releases.find((item) => item.id === releaseId)
    if (!current) return failure(new Error('发布候选不存在'))
    const intendedRevision = data.value.headRevision

    const pending: PendingOperation = {
      operationId,
      type: 'publish',
      intendedRevision,
      createdAt: new Date().toISOString(),
      candidate: structuredClone(current),
    }
    try {
      appendPendingOperation(pending)
    } catch (error) {
      return failure(new Error(`发布日志写入失败，已中止发布：${(error as Error).message}`))
    }

    // 3. CAS 提交发布；冲突时保留 WAL，用户基于最新修订重试
    const applied = commit((state) => {
      const release = state.releases.find((item) => item.id === releaseId)
      if (!release) throw new Error('发布候选不存在')
      if (release.status === 'published' && release.frozenOperationId === operationId) return

      const frozenAt = new Date().toISOString()
      release.status = 'published'
      release.publishedAt = frozenAt
      freezeReleaseEvidence(release, intendedRevision, frozenAt, operationId)
      release.eventIds.forEach((eventId) => {
        const event = state.events.find((item) => item.id === eventId)
        if (event) {
          event.status = 'published'
          state.baselines.unshift({
            id: `base-${release!.id}-${eventId}`,
            eventId,
            version: event.version,
            properties: structuredClone(event.properties),
            createdAt: frozenAt,
            status: 'published',
          })
        }
      })
      release.migrationConfirmations.forEach((confirmation) => {
        if (confirmation.status !== 'confirmed') return
        const dependency = state.dependencies.find((item) => item.id === confirmation.dependencyId)
        if (dependency) dependency.status = 'migrated'
      })
      addAudit(
        state,
        'release',
        release.id,
        '发布契约',
        `${release.version} 已发布，冻结修订 r${intendedRevision} 与确认证据`,
      )
    })

    if (applied.ok) {
      clearPendingOperation(operationId)
    }
    return applied
  }

  const syncReleaseScope = (releaseId: string): MutationResult =>
    commit((state) => {
      const release = refreshReleaseScope(state, releaseId)
      if (!release) throw new Error('发布候选不存在')
      addAudit(
        state,
        'release',
        release.id,
        '同步当前修订',
        `${release.version} 已重新比较差异并同步至修订 r${release.scopeRevision}，失效证据仍需重新核对`,
      )
    })

  const saveDeprecation = (plan: DeprecationPlan): MutationResult =>
    commit((state) => {
      const index = state.deprecations.findIndex((item) => item.id === plan.id)
      if (index >= 0) {
        state.deprecations[index] = plan
      } else {
        state.deprecations.unshift(plan)
      }
      const event = state.events.find((item) => item.id === plan.eventId)
      if (event && plan.status === 'stopped') event.status = 'deprecated'
      if (event && plan.status === 'retired') event.status = 'retired'
      addAudit(
        state,
        'deprecation',
        plan.id,
        '更新废弃计划',
        `${event?.key ?? plan.eventId}：${plan.status}`,
      )
    })

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): MutationResult => {
    const operationId = `op-rollback-${releaseId}`
    const target = data.value.releases.find((item) => item.id === releaseId)
    if (!target) return failure(new Error('发布候选不存在'))
    if (data.value.rollbacks.some((record) => record.operationId === operationId)) {
      return failure(new Error('该发布已存在回滚记录，同一回滚不可重复提交'))
    }
    const intendedRevision = data.value.headRevision + 1

    try {
      appendPendingOperation({
        operationId,
        type: 'rollback',
        intendedRevision,
        createdAt: new Date().toISOString(),
        releaseId,
        reason,
        scope,
        evidence,
        operator: '当前用户',
      })
    } catch (error) {
      return failure(new Error(`回滚日志写入失败，已中止回滚：${(error as Error).message}`))
    }

    const applied = commit((state) => {
      const record = applyRollback(state, {
        releaseId,
        reason,
        scope,
        evidence,
        operator: '当前用户',
        operationId,
        intendedRevision,
      })
      if (!record) throw new Error('发布候选不存在')
      addAudit(
        state,
        'rollback',
        record.id,
        '执行回滚',
        `${target.version} 回滚至修订 r${record.revision}，${record.reconciliation.length} 个下游已重新对账`,
      )
    })

    if (applied.ok) {
      clearPendingOperation(operationId)
    }
    return applied
  }

  const verifyRollback = (rollbackId: string, evidence: string): MutationResult =>
    commit((state) => {
      const record = state.rollbacks.find((item) => item.id === rollbackId)
      if (!record) return
      record.status = 'verified'
      record.evidence = evidence
      addAudit(state, 'rollback', record.id, '验证回滚', evidence)
    })

  const resetDemo = (): void => {
    data.value = resetState()
    recoveredOperations.value = []
    lastSavedAt.value = new Date().toISOString()
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    const reviewing = data.value.releases.find(
      (release) => release.status === 'reviewing' && release.eventIds.some((id) => selectedEvents.some((event) => event.id === id)),
    )
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        revision: data.value.headRevision,
        generatedAt: new Date().toISOString(),
        review: reviewing
          ? {
              release: reviewing.version,
              baseRevision: reviewing.baseRevision,
              scopeRevision: reviewing.scopeRevision,
              scopeStale: reviewing.staleReason?.scopeStale ?? false,
              staleReason: reviewing.staleReason?.reason ?? null,
              gateIssues: releaseGateIssues(reviewing).map((issue) => ({
                kind: issue.kind,
                target: issue.label,
                reason: issue.reason,
              })),
              migrationConfirmations: reviewing.migrationConfirmations.map((confirmation) => ({
                dependencyId: confirmation.dependencyId,
                status: confirmation.status,
                revision: confirmation.revision ?? null,
                invalidatedRevision: confirmation.invalidatedRevision ?? null,
                invalidatedReason: confirmation.invalidatedReason ?? null,
              })),
              approvals: reviewing.approvals.map((approval) => ({
                role: approval.role,
                status: approval.status,
                revision: approval.revision ?? null,
                invalidatedRevision: approval.invalidatedRevision ?? null,
                invalidatedReason: approval.invalidatedReason ?? null,
              })),
              frozenEvidence: reviewing.frozenEvidence ?? null,
            }
          : null,
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    recoveredOperations,
    lastConflictAt,
    issues,
    gateIssues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    syncReleaseScope,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
