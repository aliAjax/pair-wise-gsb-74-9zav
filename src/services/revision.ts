import type {
  DownstreamDependency,
  DownstreamReconcileItem,
  EventDefinition,
  EventProperty,
  FrozenContractEvent,
  GovernanceState,
  MigrationConfirmation,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
} from '@/models/domain'
import { affectedDependencies, contractDifferences } from '@/services/selectors'

/** 深层响应式代理经 JSON 往返得到可写入日志/快照的普通对象 */
export const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 修订号乐观锁冲突：本窗口基于旧修订提交，而其他窗口已经写入新修订 */
export class RevisionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly scope: string,
  ) {
    super(`修订号已过期：当前操作基于 r${expected}，最新修订为 r${actual}（${scope}）`)
    this.name = 'RevisionConflictError'
  }
}

const stableProperty = (property: EventProperty): unknown => ({
  id: property.id,
  name: property.name,
  displayName: property.displayName,
  type: property.type,
  required: property.required,
  description: property.description,
  enumValues: property.enumValues,
  synonyms: property.synonyms,
  platforms: property.platforms,
  lineageSourceId: property.lineageSourceId ?? null,
  deletedAt: property.deletedAt ?? null,
})

const stableRule = (rule: PlatformRule): unknown => ({
  id: rule.id,
  platform: rule.platform,
  enabled: rule.enabled,
  trigger: rule.trigger,
  owner: rule.owner,
  requiredPropertyIds: rule.requiredPropertyIds,
  note: rule.note,
})

/** 事件契约指纹：事件本身、属性（含删除标记）或平台规则任一变化都会改变 */
export const contractFingerprint = (event: EventDefinition): string =>
  JSON.stringify({
    key: event.key,
    displayName: event.displayName,
    category: event.category,
    description: event.description,
    trigger: event.trigger,
    owner: event.owner,
    version: event.version,
    status: event.status,
    properties: event.properties.map(stableProperty),
    platformRules: event.platformRules.map(stableRule),
  })

/** 发布时冻结的完整候选契约片段，用于写入失败后的完整恢复 */
export const freezeCandidate = (
  state: GovernanceState,
  release: ReleaseCandidate,
): ReleaseCandidate['frozenSnapshot'] => ({
  events: state.events
    .filter((event) => release.eventIds.includes(event.id))
    .map<FrozenContractEvent>((event) => ({
      id: event.id,
      key: event.key,
      displayName: event.displayName,
      version: event.version,
      trigger: event.trigger,
      properties: deepClone(event.properties),
      platformRules: deepClone(event.platformRules),
    })),
  confirmations: deepClone(release.migrationConfirmations),
  approvals: deepClone(release.approvals),
})

export const isConfirmationValid = (confirmation: MigrationConfirmation): boolean =>
  confirmation.status === 'confirmed' && !confirmation.invalidatedAt

export const isApprovalValid = (approval: ReleaseApproval): boolean =>
  approval.status === 'approved' && !approval.invalidatedAt

/** 候选是否携带修订号元数据（兼容历史数据） */
export const hasRevisionMeta = (release: ReleaseCandidate): boolean =>
  typeof release.baseRevision === 'number'

/**
 * 使候选中沿用旧修订的确认与审批失效。
 * 事件、属性或平台规则任一变化即视为契约修订：
 * 命中受影响下游的迁移确认以及全部四角色审批（审批针对整个候选）都失效。
 * 若没有可计算的属性差异（如仅平台规则变化），则候选内全部确认失效。
 */
export const invalidateEvidence = (
  release: ReleaseCandidate,
  revision: number,
  reason: string,
  impactedDependencyIds: string[],
  at: string,
): boolean => {
  if (release.status !== 'reviewing') return false
  const impacted = new Set(impactedDependencyIds)
  let changed = false

  release.migrationConfirmations.forEach((confirmation) => {
    if (!impacted.has(confirmation.dependencyId) || confirmation.invalidatedAt) return
    confirmation.invalidatedHistory.push({
      revision: confirmation.grantedRevision ?? release.contractRevision,
      reason: confirmation.invalidatedReason ?? '契约修订前的迁移核对结论',
      at: confirmation.confirmedAt ?? at,
      actor: confirmation.reviewer,
    })
    confirmation.invalidatedAt = at
    confirmation.invalidatedReason = reason
    changed = true
  })

  release.approvals.forEach((approval) => {
    if (approval.status !== 'approved' || approval.invalidatedAt) return
    approval.invalidatedHistory.push({
      revision: approval.grantedRevision ?? release.contractRevision,
      reason: approval.comment || '契约修订前的审批意见',
      at: approval.createdAt ?? at,
      actor: approval.actor,
    })
    approval.invalidatedAt = at
    approval.invalidatedReason = reason
    changed = true
  })

  if (changed) {
    release.contractRevision = revision
    release.staleReason = reason
  }
  return changed
}

/**
 * 候选受影响下游：属性差异命中的依赖，与候选事件直接关联的依赖取并集，
 * 以覆盖“仅平台规则变化、无属性差异”的场景。
 */
export const affectedReleaseDependencies = (
  state: GovernanceState,
  release: Pick<ReleaseCandidate, 'eventIds' | 'differences'>,
): string[] => {
  const scopedEvents = new Set(release.eventIds)
  const fromDiff = affectedDependencies(state, release.differences)
  const fromEvents = state.dependencies
    .filter((dependency) => dependency.eventIds.some((eventId) => scopedEvents.has(eventId)))
    .map((dependency) => dependency.id)
  return [...new Set([...fromDiff, ...fromEvents])]
}

/**
 * 按当前契约刷新候选差异与受影响下游清单：
 * 新增受影响下游补待确认项，已不受影响的确认项移出当前清单（历史保留在审计中）。
 */
export const refreshCandidateScope = (
  state: GovernanceState,
  release: ReleaseCandidate,
): { added: string[]; removed: string[]; impacted: string[] } => {
  const differences = contractDifferences(state, release.eventIds)
  const impacted = affectedReleaseDependencies(state, {
    eventIds: release.eventIds,
    differences,
  })
  const previous = new Set(release.affectedDependencyIds)
  const next = new Set(impacted)

  impacted.forEach((dependencyId) => {
    if (previous.has(dependencyId)) return
    release.migrationConfirmations.push({
      id: `mig-${release.id}-${dependencyId}-r${state.currentRevision}`,
      dependencyId,
      version: release.version,
      status: 'pending',
      reviewer:
        state.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
      note: '',
      invalidatedHistory: [],
    })
  })

  release.migrationConfirmations = release.migrationConfirmations.filter((confirmation) => {
    if (next.has(confirmation.dependencyId)) return true
    previous.delete(confirmation.dependencyId)
    return false
  })

  release.differences = differences
  release.affectedDependencyIds = impacted
  return {
    added: impacted.filter((id) => !previous.has(id)),
    removed: [...previous].filter((id) => !next.has(id)),
    impacted,
  }
}

/**
 * 契约修订后的统一处理：推进全局修订号，刷新所有覆盖相关事件的评审中候选，
 * 旧迁移确认与四角色审批标记失效，相关下游回到待迁移。
 */
export const bumpContractRevision = (
  state: GovernanceState,
  params: { eventIds: string[]; reason: string; actor: string },
): { revision: number; releases: ReleaseCandidate[]; impactedDependencies: string[] } => {
  state.currentRevision += 1
  const revision = state.currentRevision
  const at = new Date().toISOString()
  const touched = new Set(params.eventIds)
  const impactedDependencies = new Set<string>()
  const staleReleases: ReleaseCandidate[] = []

  state.releases.forEach((release) => {
    if (release.status !== 'reviewing') return
    if (!release.eventIds.some((eventId) => touched.has(eventId))) return
    const { impacted } = refreshCandidateScope(state, release)
    impacted.forEach((id) => impactedDependencies.add(id))
    const changed = invalidateEvidence(release, revision, params.reason, impacted, at)
    if (changed || impacted.length > 0) {
      release.contractRevision = revision
      release.staleReason = params.reason
      staleReleases.push(release)
    }
  })

  impactedDependencies.forEach((dependencyId) => {
    const dependency = state.dependencies.find((item) => item.id === dependencyId)
    if (dependency && dependency.status !== 'disabled') dependency.status = 'migration_required'
  })

  return { revision, releases: staleReleases, impactedDependencies: [...impactedDependencies] }
}

/**
 * 回滚后按当前契约重新对账下游迁移状态：
 * 仍引用已删除属性的下游必须重新迁移；其余随回滚后的契约恢复启用。
 */
export const reconcileDependencies = (
  state: GovernanceState,
  eventIds: string[],
  reason: string,
): DownstreamReconcileItem[] => {
  const scoped = new Set(eventIds)
  const results: DownstreamReconcileItem[] = []

  state.dependencies.forEach((dependency) => {
    if (dependency.status === 'disabled') return
    if (!dependency.eventIds.some((eventId) => scoped.has(eventId))) return

    const referencesBroken = dependency.propertyRefs.some((reference) => {
      const event = state.events.find((item) => item.id === reference.eventId)
      const property = event?.properties.find((item) => item.id === reference.propertyId)
      return !property || Boolean(property.deletedAt)
    })
    const target: DownstreamDependency['status'] = referencesBroken
      ? 'migration_required'
      : 'active'

    if (dependency.status === target) return
    results.push({
      dependencyId: dependency.id,
      fromStatus: dependency.status,
      toStatus: target,
      reason: referencesBroken
        ? `${reason}：仍引用已删除属性，需要重新迁移`
        : `${reason}：引用字段在回滚后契约中有效，恢复启用`,
    })
    dependency.status = target
  })

  return results
}

/** 回滚也产生新修订：覆盖回滚事件范围的评审中候选的旧确认/审批全部失效 */
export const bumpRollbackRevision = (
  state: GovernanceState,
  params: { eventIds: string[]; version: string; reason: string; actor: string },
): { revision: number; impactedDependencies: string[] } => {
  state.currentRevision += 1
  const revision = state.currentRevision
  const at = new Date().toISOString()
  const reason = `回滚至 ${params.version} 后的契约重新生效（r${revision}）：${params.reason}`
  const impactedDependencies = new Set<string>()

  state.releases.forEach((release) => {
    if (release.status !== 'reviewing') return
    if (!release.eventIds.some((eventId) => params.eventIds.includes(eventId))) return
    const { impacted } = refreshCandidateScope(state, release)
    impacted.forEach((id) => impactedDependencies.add(id))
    invalidateEvidence(release, revision, reason, impacted, at)
    release.contractRevision = revision
    release.staleReason = reason
  })

  return { revision, impactedDependencies: [...impactedDependencies] }
}

/** 断言操作基于的修订号仍然是最新修订，迟到的旧修订一律拒绝 */
export const assertRevisionCurrent = (
  state: GovernanceState,
  expectedRevision: number | undefined,
  scope: string,
): void => {
  if (typeof expectedRevision !== 'number') return
  if (expectedRevision < state.currentRevision) {
    throw new RevisionConflictError(expectedRevision, state.currentRevision, scope)
  }
}
