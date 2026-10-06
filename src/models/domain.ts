export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

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
  /** 产生该基线的发布，用于发布重放时幂等去重 */
  releaseId?: string
  revision?: number
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

export interface InvalidationMark {
  revision: number
  reason: string
  at: string
  actor: string
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected'
  reviewer: string
  note: string
  confirmedAt?: string
  /** 该确认最近一次被认可时所基于的修订号 */
  grantedRevision?: number
  /** 非空表示该确认已因后续契约修订失效，需要下游重新核对 */
  invalidatedAt?: string
  invalidatedReason?: string
  invalidatedHistory: InvalidationMark[]
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
  /** 该审批最近一次通过时所基于的修订号 */
  grantedRevision?: number
  /** 非空表示该审批已因后续契约修订失效，需要角色重新审批 */
  invalidatedAt?: string
  invalidatedReason?: string
  invalidatedHistory: InvalidationMark[]
}

export interface FrozenContractEvent {
  id: string
  key: string
  displayName: string
  version: string
  trigger: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
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
  /** 候选创建时所基于的契约修订号 */
  baseRevision: number
  /** 候选当前确认/审批有效的最新契约修订号，小于全局修订号即已过期 */
  contractRevision: number
  /** 最近一次使候选确认/审批失效的原因 */
  staleReason?: string
  /** 发布时冻结的修订号 */
  frozenRevision?: number
  frozenAt?: string
  /** 发布时冻结的完整契约候选，用于写入失败后的完整恢复 */
  frozenSnapshot?: {
    events: FrozenContractEvent[]
    confirmations: MigrationConfirmation[]
    approvals: ReleaseApproval[]
  }
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
  /** 回滚执行时产生的修订号，与候选、契约修订共用同一序列 */
  revision: number
  /** 回滚验证完成、下游按回滚后契约重新对账的时间 */
  reconciledAt?: string
}

/**
 * 发布两阶段提交日志：先写 prepare（含完整候选快照），再执行发布，
 * 任一阶段写入失败都可在下个会话从快照恢复，且同一修订重放幂等。
 */
export interface PublishJournal {
  id: string
  releaseId: string
  revision: number
  phase: 'prepared' | 'committed'
  candidate: ReleaseCandidate
  createdAt: string
  committedAt?: string
  recoveredAt?: string
}

export interface DownstreamReconcileItem {
  dependencyId: string
  fromStatus: DownstreamDependency['status']
  toStatus: DownstreamDependency['status']
  reason: string
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
  /** 全局单调修订号：契约修订与回滚共用，候选在发布时冻结它 */
  currentRevision: number
  /** 未完成的发布提交日志，用于写入失败后的完整恢复 */
  publishJournals: PublishJournal[]
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
