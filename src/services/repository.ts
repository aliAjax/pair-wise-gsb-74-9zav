import type { GovernanceState, PublishJournal } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v1'
const FAULT_KEY = 'eventrail-fault-injection-v1'

/** 模拟 localStorage 写入失败，用于演练发布两阶段提交的恢复路径 */
export class StateWriteError extends Error {
  constructor(public readonly phase: 'prepare' | 'commit') {
    super(
      phase === 'prepare'
        ? '模拟发布提交日志写入失败，发布尚未开始'
        : '模拟发布结果写入失败，可从已冻结的完整候选恢复',
    )
    this.name = 'StateWriteError'
  }
}

/** 补齐历史版本本地数据中缺失的修订号字段 */
const migrate = (raw: GovernanceState): GovernanceState => {
  const state = raw as GovernanceState & {
    currentRevision?: number
    publishJournals?: PublishJournal[]
  }
  if (typeof state.currentRevision !== 'number') state.currentRevision = 8
  if (!Array.isArray(state.publishJournals)) state.publishJournals = []
  state.releases.forEach((release) => {
    if (typeof release.baseRevision !== 'number') release.baseRevision = state.currentRevision
    if (typeof release.contractRevision !== 'number') {
      release.contractRevision = release.baseRevision
    }
    release.migrationConfirmations.forEach((confirmation) => {
      if (!Array.isArray(confirmation.invalidatedHistory)) confirmation.invalidatedHistory = []
    })
    release.approvals.forEach((approval) => {
      if (!Array.isArray(approval.invalidatedHistory)) approval.invalidatedHistory = []
    })
  })
  state.rollbacks.forEach((record) => {
    if (typeof record.revision !== 'number') record.revision = 0
  })
  return state as GovernanceState
}

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return migrate(JSON.parse(raw) as GovernanceState)
  } catch {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export const saveState = (
  state: GovernanceState,
  journalPhase?: 'prepare' | 'commit',
): void => {
  const fault = journalPhase ? localStorage.getItem(FAULT_KEY) : null
  if (journalPhase && fault === journalPhase) {
    // 故障只注入一次：保留此前已持久化的阶段（prepare），用于刷新后恢复
    localStorage.removeItem(FAULT_KEY)
    throw new StateWriteError(journalPhase)
  }
  const serialized = JSON.parse(JSON.stringify(state)) as GovernanceState
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized))
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  localStorage.removeItem(FAULT_KEY)
  saveState(seed)
  return seed
}

export const setWriteFault = (phase: 'prepare' | 'commit' | ''): void => {
  if (phase) localStorage.setItem(FAULT_KEY, phase)
  else localStorage.removeItem(FAULT_KEY)
}

export const getWriteFault = (): 'prepare' | 'commit' | '' =>
  (localStorage.getItem(FAULT_KEY) as 'prepare' | 'commit' | null) ?? ''

export const STORAGE_EVENT_KEY = STORAGE_KEY

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
