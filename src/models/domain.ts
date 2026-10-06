export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type RevisionKind = 'contract' | 'rollback'
/** 迁移确认与四角色审批共用的证据状态 */
export type EvidenceStatus =
  | 'pending'
  | 'confirmed'
  | 'approved'
  | 'rejected'
  | 'invalidated'

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: EvidenceStatus
  reviewer: string
  note: string
  confirmedAt?: string
  /** 确认所基于的契约修订号 */
  revision?: number
  /** 被后续契约修订作废时的修订号 */
  invalidatedRevision?: number
  /** 失效原因（事件/属性/平台规则变化或回滚对账） */
  invalidatedReason?: string
  /** 作废前的状态，用于审计 */
  previousStatus?: EvidenceStatus
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: EvidenceStatus
  comment: string
  createdAt?: string
  /** 审批所基于的契约修订号 */
  revision?: number
  invalidatedRevision?: number
  invalidatedReason?: string
  previousStatus?: EvidenceStatus
}

/** 候选/证据的失效原因，页面与导出共用 */
export interface StaleReason {
  /** 触发失效或作用域变化的修订号 */
  revision: number
  /** 该候选是否仍停留在旧修订（契约变化未被纳入当前候选差异） */
  scopeStale: boolean
  /** 人类可读原因 */
  reason: string
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  createdAt: string
  publishedAt?: string
  /** 候选创建时的契约修订号 */
  baseRevision: number
  /** 候选作用域最近一次被契约修订波及的修订号 */
  scopeRevision: number
  /** 当前契约最新修订号（用于页面判断候选是否落后） */
  staleReason?: StaleReason
  /** 发布时冻结的契约修订号（已发布后不再变化） */
  frozenRevision?: number
  /** 发布时冻结的确认与审批证据 */
  frozenEvidence?: FrozenEvidence
  /** 幂等键：同修订/同候选重放发布时不重复生成记录 */
  frozenOperationId?: string
}

/** 发布时刻冻结的确认证据快照 */
export interface FrozenEvidence {
  revision: number
  frozenAt: string
  migrationConfirmations: Array<{
    dependencyId: string
    reviewer: string
    note: string
    revision?: number
    confirmedAt?: string
  }>
  approvals: Array<{
    role: ReleaseApproval['role']
    actor: string
    comment: string
    revision?: number
    createdAt?: string
  }>
}

/** 契约修订台账条目：事件、属性、平台规则的每一次变化与回滚共用一条修订号 */
export interface ContractRevision {
  revision: number
  kind: RevisionKind
  source: 'event' | 'property' | 'platform_rule' | 'rollback'
  entityId: string
  eventId?: string
  summary: string
  detail: string
  actor: string
  createdAt: string
  /** 回滚记录 id（仅 kind=rollback） */
  rollbackId?: string
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  version: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
  /** 回滚发布与候选共用的契约修订号 */
  revision: number
  /** 回滚后按当前契约重新对账的下游迁移状态 */
  reconciliation: RollbackReconciliationItem[]
  /** 幂等键：同一回滚重放不重复生成记录 */
  operationId: string
}

export interface RollbackReconciliationItem {
  dependencyId: string
  dependencyName: string
  /** 对账后的下游迁移状态 */
  status: DownstreamDependency['status']
  matched: boolean
  detail: string
}

/** 发布/回滚前预写的恢复日志，写入失败后可从完整候选恢复 */
export interface PendingOperation {
  operationId: string
  type: 'publish' | 'rollback'
  /** 操作预期冻结/推进到的修订号 */
  intendedRevision: number
  createdAt: string
  /** publish：完整候选快照 */
  candidate?: ReleaseCandidate
  /** rollback 参数 */
  releaseId?: string
  reason?: string
  scope?: string
  evidence?: string
  operator?: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  audit: AuditEvent[]
  currentVersion: string
  /** 全局单调修订号，候选、契约修订与回滚记录共用 */
  headRevision: number
  /** 修订台账（按修订号倒序存储也可，这里按产生顺序） */
  revisions: ContractRevision[]
  /** 每次成功提交自增的存储版本，用于多窗口乐观并发控制 */
  stateVersion: number
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
