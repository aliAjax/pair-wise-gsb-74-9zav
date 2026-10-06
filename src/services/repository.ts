import type { GovernanceState, PendingOperation } from '@/models/domain'
import { createSeedState } from '@/models/seed'
import { createId } from '@/services/ids'
import { recoverPendingOperations } from '@/services/revision'

export { createId }

const STORAGE_KEY = 'eventrail-governance-v1'
const PENDING_KEY = 'eventrail-governance-pending-v1'

/** 其他窗口的提交覆盖了本地基准修订时抛出，调用方必须基于最新状态重试 */
export class RevisionConflictError extends Error {
  latest: GovernanceState

  constructor(latest: GovernanceState) {
    super('契约修订已被其他窗口推进，当前操作基于过期修订，请刷新后基于最新修订重试')
    this.name = 'RevisionConflictError'
    this.latest = latest
  }
}

/** 兼容旧版本 localStorage：补齐修订号、状态版本与回滚字段 */
const normalizeState = (state: GovernanceState): GovernanceState => {
  state.headRevision ??= 0
  state.revisions ??= []
  state.stateVersion ??= 0
  state.releases.forEach((release) => {
    release.baseRevision ??= 0
    release.scopeRevision ??= 0
  })
  state.rollbacks.forEach((record) => {
    record.revision ??= 0
    record.operationId ??= `legacy-${record.id}`
    record.reconciliation ??= []
  })
  return state
}

const readState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return normalizeState(JSON.parse(raw) as GovernanceState)
  } catch {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

let recoveryNotice: PendingOperation[] = []

/** 应用启动后消费一次写入失败恢复提示 */
export const consumeRecoveryNotice = (): PendingOperation[] => {
  const notice = recoveryNotice
  recoveryNotice = []
  return notice
}

export const loadPendingOperations = (): PendingOperation[] => {
  const raw = localStorage.getItem(PENDING_KEY)
  if (!raw) return []
  try {
    return (JSON.parse(raw) as PendingOperation[]) ?? []
  } catch {
    return []
  }
}

const writePendingOperations = (operations: PendingOperation[]): void => {
  localStorage.setItem(PENDING_KEY, JSON.stringify(operations))
}

export const appendPendingOperation = (operation: PendingOperation): void => {
  const operations = loadPendingOperations()
  if (!operations.some((item) => item.operationId === operation.operationId)) {
    operations.push(operation)
  }
  writePendingOperations(operations)
}

export const clearPendingOperation = (operationId: string): void => {
  writePendingOperations(
    loadPendingOperations().filter((operation) => operation.operationId !== operationId),
  )
}

export const loadState = (): GovernanceState => {
  const state = readState()

  // 上次写入在崩溃/失败后中断：按预写日志从完整候选幂等恢复
  const pending = loadPendingOperations()
  if (pending.length > 0) {
    const { recovered } = recoverPendingOperations(state, pending)
    if (recovered.length > 0) {
      recoveryNotice = recovered
      writePendingOperations(
        pending.filter((operation) => !recovered.some((item) => item.operationId === operation.operationId)),
      )
      state.stateVersion += 1
      localStorage.setItem(STORAGE_KEY, JSON.stringify(structuredClone(state)))
    }
  }

  return state
}

/**
 * 乐观并发提交：expectedStateVersion 必须与存储中的最新版本一致，
 * 否则说明其他窗口已经写入，迟到的旧修订不能覆盖新修订。
 */
export const saveState = (
  state: GovernanceState,
  expectedStateVersion?: number,
): void => {
  const raw = localStorage.getItem(STORAGE_KEY)
  let stored: GovernanceState | null = null
  if (raw) {
    try {
      stored = normalizeState(JSON.parse(raw) as GovernanceState)
    } catch {
      stored = null
    }
  }

  const storedVersion = stored?.stateVersion ?? 0
  if (
    expectedStateVersion !== undefined &&
    stored !== null &&
    storedVersion !== expectedStateVersion
  ) {
    throw new RevisionConflictError(structuredClone(stored!))
  }

  state.stateVersion = storedVersion + 1
  localStorage.setItem(STORAGE_KEY, JSON.stringify(structuredClone(state)))
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  writePendingOperations([])
  saveState(seed)
  return seed
}

type ExternalStateListener = (state: GovernanceState) => void
const externalListeners = new Set<ExternalStateListener>()

/** 其他浏览器窗口完成提交时，同步本地基准修订 */
export const onExternalState = (listener: ExternalStateListener): (() => void) => {
  externalListeners.add(listener)
  return () => externalListeners.delete(listener)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      const state = normalizeState(JSON.parse(event.newValue) as GovernanceState)
      externalListeners.forEach((listener) => listener(state))
    } catch {
      // 忽略其他窗口写入的不可解析中间态
    }
  })
}
