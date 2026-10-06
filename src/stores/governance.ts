import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  PublishJournal,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import {
  createId,
  loadState,
  resetState,
  saveState,
  STORAGE_EVENT_KEY,
} from '@/services/repository'
import {
  affectedDependencies,
  contractDifferences,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'
import {
  assertRevisionCurrent,
  bumpContractRevision,
  bumpRollbackRevision,
  contractFingerprint,
  deepClone,
  freezeCandidate,
  isApprovalValid,
  isConfirmationValid,
  reconcileDependencies,
  RevisionConflictError,
} from '@/services/revision'

export { RevisionConflictError }

const CONTRACT_ACTOR = '当前用户'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  /** 其他浏览器窗口写入了更新修订号时，提示当前窗口已落后 */
  const externalUpdateAt = ref<string | null>(null)
  /** 本次会话内发布提交失败的日志，页面可据此提供“立即恢复”入口 */
  const failedPublish = ref<PublishJournal | null>(null)
  /** 启动时从写入失败中恢复的发布日志，页面展示恢复告知 */
  const recoveredPublishes = ref<PublishJournal[]>([])

  const issues = computed(() => validateGovernance(data.value))

  const persist = (journalPhase?: 'prepare' | 'commit'): void => {
    saveState(data.value, journalPhase)
    lastSavedAt.value = new Date().toISOString()
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: CONTRACT_ACTOR,
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  const fingerprintMap = (): Map<string, string> =>
    new Map(data.value.events.map((event) => [event.id, contractFingerprint(event)]))

  /**
   * 执行一次契约编辑：先校验调用方是否仍基于最新修订，再比对事件契约指纹，
   * 只有事件、属性或平台规则真正变化时才推进修订号并使旧确认/审批失效。
   */
  const mutateContract = (
    mutate: () => { eventIds: string[]; reason: string },
    expectedRevision?: number,
  ): { revision: number; changed: boolean; impactedDependencies: string[] } => {
    assertRevisionCurrent(data.value, expectedRevision, '契约编辑')
    const before = fingerprintMap()
    const { eventIds, reason } = mutate()
    const changedIds = eventIds.filter((eventId) => before.get(eventId) !== undefined
      ? before.get(eventId) !==
        contractFingerprint(data.value.events.find((event) => event.id === eventId)!)
      : true)

    if (changedIds.length === 0) {
      persist()
      return { revision: data.value.currentRevision, changed: false, impactedDependencies: [] }
    }

    const result = bumpContractRevision(data.value, {
      eventIds: changedIds,
      reason,
      actor: CONTRACT_ACTOR,
    })
    persist()
    return { revision: result.revision, changed: true, impactedDependencies: result.impactedDependencies }
  }

  // 由布局层在多窗口 storage 事件中调用：同步最新状态，绝不允许旧窗口覆盖新修订
  const syncFromStorage = (): void => {
    const incoming = loadState()
    if (incoming.currentRevision === data.value.currentRevision) return
    if (incoming.currentRevision < data.value.currentRevision) return
    data.value = incoming
    externalUpdateAt.value = new Date().toISOString()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_EVENT_KEY) syncFromStorage()
    })
  }

  const saveEvent = (event: EventDefinition, expectedRevision?: number): number => {
    const existed = data.value.events.some((item) => item.id === event.id)
    return mutateContract(
      () => {
        const index = data.value.events.findIndex((item) => item.id === event.id)
        const saved = { ...event, updatedAt: new Date().toISOString() }
        if (index >= 0) {
          data.value.events[index] = saved
        } else {
          data.value.events.unshift(saved)
        }
        audit('event', event.id, existed ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
        return {
          eventIds: [event.id],
          reason: `事件 ${event.key} 契约发生修订`,
        }
      },
      expectedRevision,
    ).revision
  }

  const saveProperty = (
    eventId: string,
    property: EventProperty,
    expectedRevision?: number,
  ): number => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return data.value.currentRevision
    const existed = event.properties.some((item) => item.id === property.id)
    return mutateContract(
      () => {
        const target = data.value.events.find((item) => item.id === eventId)!
        const index = target.properties.findIndex((item) => item.id === property.id)
        if (index >= 0) {
          target.properties[index] = property
        } else {
          target.properties.push(property)
        }
        target.updatedAt = new Date().toISOString()
        audit(
          'property',
          property.id,
          existed ? '更新属性' : '新增属性',
          `${target.key}.${property.name}`,
        )
        return {
          eventIds: [eventId],
          reason: `事件 ${event.key} 的属性 ${property.name} 发生修订`,
        }
      },
      expectedRevision,
    ).revision
  }

  const deleteProperty = (eventId: string, propertyId: string, expectedRevision?: number): number => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return data.value.currentRevision
    return mutateContract(
      () => {
        const target = data.value.events.find((item) => item.id === eventId)!
        const targetProperty = target.properties.find((item) => item.id === propertyId)!
        targetProperty.deletedAt = new Date().toISOString()
        target.updatedAt = new Date().toISOString()
        audit(
          'property',
          propertyId,
          '标记删除',
          `${target.key}.${targetProperty.name} 进入删除兼容期`,
        )
        return {
          eventIds: [eventId],
          reason: `事件 ${event.key} 删除属性 ${property.name}`,
        }
      },
      expectedRevision,
    ).revision
  }

  const savePlatformRule = (
    eventId: string,
    rule: PlatformRule,
    expectedRevision?: number,
  ): number => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return data.value.currentRevision
    const existed = event.platformRules.some((item) => item.id === rule.id)
    return mutateContract(
      () => {
        const target = data.value.events.find((item) => item.id === eventId)!
        const index = target.platformRules.findIndex((item) => item.id === rule.id)
        if (index >= 0) {
          target.platformRules[index] = rule
        } else {
          target.platformRules.push(rule)
        }
        target.updatedAt = new Date().toISOString()
        audit(
          'platform_rule',
          rule.id,
          existed ? '更新平台规则' : '新增平台规则',
          `${target.key}/${rule.platform}`,
        )
        return {
          eventIds: [eventId],
          reason: `事件 ${event.key} 的 ${rule.platform} 平台规则发生修订`,
        }
      },
      expectedRevision,
    ).revision
  }

  const createRelease = (
    version: string,
    title: string,
    eventIds: string[],
    expectedRevision?: number,
  ): ReleaseCandidate => {
    assertRevisionCurrent(data.value, expectedRevision, '创建发布候选')
    const revision = data.value.currentRevision
    const differences = contractDifferences(data.value, eventIds)
    const affected = affectedDependencies(data.value, differences)
    const release: ReleaseCandidate = {
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
          data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
        invalidatedHistory: [],
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '', invalidatedHistory: [] },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '', invalidatedHistory: [] },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '', invalidatedHistory: [] },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '', invalidatedHistory: [] },
      ],
      createdAt: new Date().toISOString(),
      baseRevision: revision,
      contractRevision: revision,
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version}（r${revision}）包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖`,
    )
    persist()
    return release
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
    expectedRevision?: number,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!release || !confirmation) return
    assertRevisionCurrent(data.value, expectedRevision, '迁移确认')
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    confirmation.grantedRevision = data.value.currentRevision
    confirmation.invalidatedAt = undefined
    confirmation.invalidatedReason = undefined
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    audit(
      'dependency',
      confirmation.dependencyId,
      '确认迁移',
      `${reviewer} 基于 r${data.value.currentRevision} 重新核对：${note}`,
    )
    persist()
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
    expectedRevision?: number,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const approval = release?.approvals.find((item) => item.role === role)
    if (!release || !approval) return
    assertRevisionCurrent(data.value, expectedRevision, '四角色审批')
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    if (status === 'approved') {
      approval.grantedRevision = data.value.currentRevision
      approval.invalidatedAt = undefined
      approval.invalidatedReason = undefined
    }
    audit(
      'release',
      releaseId,
      status === 'approved' ? '审批通过' : '审批驳回',
      `${role} 基于 r${data.value.currentRevision}：${comment}`,
    )
    persist()
  }

  const evidenceReady = (release: ReleaseCandidate): boolean => {
    const scoped = new Set(release.affectedDependencyIds)
    const migrationsReady = release.migrationConfirmations
      .filter((item) => scoped.has(item.dependencyId))
      .every(isConfirmationValid)
    const approvalsReady = release.approvals.every(isApprovalValid)
    return migrationsReady && approvalsReady
  }

  /** 幂等地把发布结果落到状态上（基线按发布+事件去重），同一修订重放不重复生成记录 */
  const applyPublish = (release: ReleaseCandidate, revision: number, at: string): void => {
    release.status = 'published'
    if (!release.publishedAt) release.publishedAt = at
    release.frozenRevision = revision
    release.frozenAt = at
    if (!release.frozenSnapshot) release.frozenSnapshot = freezeCandidate(data.value, release)
    release.contractRevision = revision
    release.staleReason = undefined
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (!event) return
      event.status = 'published'
      // 同一修订重放幂等：按发布修订号+事件去重（releaseId 仅用于追溯）
      const exists = data.value.baselines.some(
        (baseline) => baseline.revision === revision && baseline.eventId === eventId,
      )
      if (!exists) {
        data.value.baselines.unshift({
          id: createId('base'),
          releaseId: release.id,
          revision,
          eventId,
          version: event.version,
          properties: deepClone(event.properties),
          createdAt: at,
          status: 'published',
        })
      }
    })
    const audited = data.value.audit.some(
      (item) => item.entityId === release.id && item.action === '发布契约',
    )
    if (!audited) {
      audit('release', release.id, '发布契约', `${release.version} 已冻结 r${revision} 发布`)
    }
  }

  const recoverPendingPublishes = (): PublishJournal[] => {
    const pending = data.value.publishJournals.filter(
      (journal) => journal.phase === 'prepared' || !journal.committedAt,
    )
    const recovered: PublishJournal[] = []
    const recoveredIds = new Set<string>()
    pending.forEach((journal) => {
      const release = data.value.releases.find((item) => item.id === journal.releaseId)
      const target = release ?? journal.candidate
      if (!data.value.releases.some((item) => item.id === target.id)) {
        data.value.releases.unshift(target)
      }
      const live = data.value.releases.find((item) => item.id === target.id)!
      applyPublish(live, journal.revision, journal.committedAt ?? journal.createdAt)
      journal.phase = 'committed'
      journal.committedAt = new Date().toISOString()
      journal.recoveredAt = journal.committedAt
      recoveredIds.add(journal.id)
      recovered.push(deepClone(journal))
    })
    if (recovered.length > 0) {
      // 恢复完成后清除已提交日志（同一修订再次加载不会重复恢复）
      data.value.publishJournals = data.value.publishJournals.filter(
        (journal) => !recoveredIds.has(journal.id),
      )
      persist()
      recoveredPublishes.value = recovered
    }
    return recovered
  }

  // 应用启动即尝试从写入失败中恢复
  recoverPendingPublishes()

  /**
   * 发布两阶段提交：
   * 1) 校验门禁后先写 prepare 日志（含冻结修订号的完整候选快照）
   * 2) 再写发布结果（commit）
   * prepare 写入失败：发布尚未发生；commit 写入失败：刷新后由 recoverPendingPublishes 恢复
   */
  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return false
    if (release.status !== 'reviewing') return false
    const readiness = releaseReadiness(release, issues.value)
    if (!evidenceReady(release) || readiness < 90) return false

    const existing = data.value.publishJournals.find(
      (journal) => journal.releaseId === releaseId && journal.phase === 'prepared',
    )
    const revision = data.value.currentRevision
    const frozen = { ...release, frozenRevision: revision, frozenSnapshot: freezeCandidate(data.value, release) }
    const journal: PublishJournal =
      existing ?? {
        id: createId('jrn'),
        releaseId,
        revision,
        phase: 'prepared',
        candidate: deepClone(frozen),
        createdAt: new Date().toISOString(),
      }
    journal.candidate = deepClone(frozen)
    if (!existing) data.value.publishJournals.push(journal)
    persist('prepare')

    applyPublish(release, revision, new Date().toISOString())
    journal.phase = 'committed'
    journal.committedAt = release.publishedAt
    journal.candidate = deepClone(release)
    try {
      persist('commit')
      data.value.publishJournals = data.value.publishJournals.filter((item) => item.id !== journal.id)
      persist()
    } catch (error) {
      // 结果未持久化：prepare 日志已落盘，刷新或“立即恢复”可从完整候选重放
      failedPublish.value = deepClone(journal)
      throw error
    }
    return true
  }

  /** 发布结果写入失败后，在不刷新的情况下立即重放恢复（幂等） */
  const recoverFailedPublish = (): boolean => {
    const journal = failedPublish.value
    if (!journal) return false
    const release = data.value.releases.find((item) => item.id === journal.releaseId)
    const target = release ?? journal.candidate
    if (!data.value.releases.some((item) => item.id === target.id)) {
      data.value.releases.unshift(target)
    }
    const live = data.value.releases.find((item) => item.id === target.id)!
    applyPublish(live, journal.revision, journal.committedAt ?? new Date().toISOString())
    journal.phase = 'committed'
    journal.committedAt = live.publishedAt
    journal.recoveredAt = new Date().toISOString()
    persist()
    data.value.publishJournals = data.value.publishJournals.filter((item) => item.id !== journal.id)
    persist()
    failedPublish.value = null
    return true
  }

  const dismissRecoveryNotice = (): void => {
    recoveredPublishes.value = []
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') event.status = 'deprecated'
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  /**
   * 回滚：回滚本身产生新修订号，回滚记录与候选、契约修订共用同一序列；
   * 候选记录保留，覆盖范围内评审中候选的旧确认/审批失效，下游按回滚后契约重新对账。
   */
  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
    expectedRevision?: number,
  ): RollbackRecord | null => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return null
    assertRevisionCurrent(data.value, expectedRevision, '执行回滚')
    // 同一发布的回滚重放幂等：不重复生成回滚记录与修订号
    const existing = data.value.rollbacks.find((item) => item.releaseId === releaseId)
    if (existing) return existing

    const rollback: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: release.version,
      reason,
      operator: CONTRACT_ACTOR,
      scope,
      createdAt: new Date().toISOString(),
      status: 'executed',
      evidence,
      revision: 0,
    }

    const { revision, impactedDependencies } = bumpRollbackRevision(data.value, {
      eventIds: release.eventIds,
      version: release.version,
      reason,
      actor: CONTRACT_ACTOR,
    })
    rollback.revision = revision

    release.status = 'rolled_back'
    release.staleReason = `已在 r${revision} 回滚，候选保留待按回滚后契约重新核对`

    const reconciled = reconcileDependencies(
      data.value,
      release.eventIds,
      `回滚 r${revision}（${release.version}）`,
    )
    impactedDependencies.forEach((dependencyId) => {
      const dependency = data.value.dependencies.find((item) => item.id === dependencyId)
      if (dependency && dependency.status !== 'disabled') dependency.status = 'migration_required'
    })

    data.value.rollbacks.unshift(rollback)
    audit(
      'rollback',
      rollback.id,
      '执行回滚',
      `${release.version} r${revision}：${reason}；下游对账 ${reconciled.length} 项`,
    )
    persist()
    return rollback
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    record.reconciledAt = new Date().toISOString()
    const release = data.value.releases.find((item) => item.id === record.releaseId)
    if (release) {
      // 验证时再次对账，确保回滚后契约变化都反映到下游迁移状态
      reconcileDependencies(data.value, release.eventIds, `回滚验证 r${record.revision}`)
    }
    audit('rollback', record.id, '验证回滚', `${evidence}（r${record.revision} 对账完成）`)
    persist()
  }

  const resetDemo = (): void => {
    data.value = resetState()
    failedPublish.value = null
    recoveredPublishes.value = []
    externalUpdateAt.value = null
    lastSavedAt.value = new Date().toISOString()
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    const reviewing = data.value.releases.filter((release) => release.status === 'reviewing')
    const invalidations = reviewing.flatMap((release) => {
      const scopedEvents = new Set(
        release.eventIds.filter((eventId) =>
          selectedEvents.some((event) => event.id === eventId),
        ),
      )
      if (scopedEvents.size === 0 || !release.staleReason) return []
      return [
        {
          release: release.version,
          baseRevision: release.baseRevision,
          contractRevision: release.contractRevision,
          frozen: typeof release.frozenRevision === 'number',
          reason: release.staleReason,
          staleConfirmations: release.migrationConfirmations
            .filter((item) => item.invalidatedAt)
            .map((item) => ({
              dependencyId: item.dependencyId,
              reviewer: item.reviewer,
              reason: item.invalidatedReason,
            })),
          staleApprovals: release.approvals
            .filter((item) => item.invalidatedAt)
            .map((item) => ({ role: item.role, actor: item.actor, reason: item.invalidatedReason })),
        },
      ]
    })
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        revision: data.value.currentRevision,
        generatedAt: new Date().toISOString(),
        invalidations,
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
    externalUpdateAt,
    failedPublish,
    recoveredPublishes,
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    confirmMigration,
    updateApproval,
    publishRelease,
    recoverFailedPublish,
    dismissRecoveryNotice,
    evidenceReady,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
