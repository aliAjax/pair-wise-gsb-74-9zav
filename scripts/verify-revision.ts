import { createPinia, setActivePinia } from 'pinia'
import { setWriteFault, StateWriteError } from '../src/services/repository'
import { RevisionConflictError } from '../src/services/revision'
import { useGovernanceStore } from '../src/stores/governance'

const memory = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) =>
    void memory.set(key, JSON.parse(JSON.stringify(String(value)))),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
}
;(globalThis as any).window = undefined

let passed = 0
const check = (name: string, condition: boolean, detail = ''): void => {
  if (!condition) {
    console.error(`✗ ${name} ${detail}`)
    process.exit(1)
  }
  passed += 1
  console.log(`✓ ${name}`)
}

const freshStore = (): ReturnType<typeof useGovernanceStore> => {
  setActivePinia(createPinia())
  return useGovernanceStore()
}

// ---------- 1. 初始种子即体现失效 ----------
let store = freshStore()
const rel001 = store.data.releases.find((r) => r.id === 'rel-001')!
check('全局修订号初始化为 r9', store.data.currentRevision === 9)
check('候选带基线/当前修订号', rel001.baseRevision === 8 && rel001.contractRevision === 9)
check(
  '旧迁移确认已标记失效并保留原因',
  rel001.migrationConfirmations.find((c) => c.id === 'mig-002')?.invalidatedAt !== undefined &&
    rel001.migrationConfirmations.find((c) => c.id === 'mig-002')?.invalidatedHistory.length === 1,
)
check(
  '旧四角色审批已标记失效',
  rel001.approvals.find((a) => a.id === 'appr-001')?.invalidatedAt !== undefined,
)
check('失效候选不可发布（门禁拦截）', store.evidenceReady(rel001) === false)
check('发布被拒绝', store.publishRelease('rel-001') === false)

// ---------- 2. 迟到的旧修订不能盖住新修订 ----------
const evt003 = store.data.events.find((e) => e.id === 'evt-003')!
const bumped = store.saveProperty(
  'evt-003',
  { ...evt003.properties.find((p) => p.id === 'prop-014')!, description: '结果所在页码（修订）' },
  9, // 模拟另一个窗口已落后
)
check('r9 之后的提交使修订号推进到 r10', bumped === 10 && store.data.currentRevision === 10)
let conflictCaught = false
try {
  store.saveProperty(
    'evt-003',
    { ...evt003.properties.find((p) => p.id === 'prop-014')!, description: '迟到旧修订' },
    9,
  )
} catch (error) {
  conflictCaught = error instanceof RevisionConflictError
}
check('基于 r9 的迟到提交抛出修订冲突', conflictCaught)
check('契约变更后候选修订号同步到 r10', rel001.contractRevision === 10)

// 无实际内容变化的保存不推进修订号
const noBump = store.saveProperty(
  'evt-003',
  { ...evt003.properties.find((p) => p.id === 'prop-014')!, description: '结果所在页码（修订）' },
  10,
)
check('内容无变化的保存不产生新修订', noBump === 10)

// 平台规则变化同样推进修订并失效候选
const rule = evt003.platformRules[0]!
store.savePlatformRule('evt-003', { ...rule, note: `${rule.note}（补充时序说明）` }, 10)
check('平台规则变化推进到 r11', store.data.currentRevision === 11)
check('平台规则变化后候选仍标记失效原因', Boolean(rel001.staleReason))

// ---------- 3. 下游按新修订重新核对、四角色重新审批后才能发布 ----------
// 平台规则修订后，直接订阅候选事件的下游也纳入重新核对（如 dep-002 订阅 evt-001）
const confirmationIds = rel001.migrationConfirmations.map((c) => c.id)
check('修订后候选纳入全部相关下游重新核对', confirmationIds.includes('mig-001'))
confirmationIds.forEach((id, index) => {
  const confirmation = rel001.migrationConfirmations.find((c) => c.id === id)!
  store.confirmMigration('rel-001', id, confirmation.reviewer || `核对人${index}`, `按 r11 重新核对 ${id}`, 11)
})
check(
  '迁移确认重新核对后失效标记清除并记录核对修订',
  rel001.migrationConfirmations.every((c) => !c.invalidatedAt && c.grantedRevision === 11),
)
check('仅迁移确认完成时仍不可发布', store.evidenceReady(rel001) === false)
;(['data', 'product', 'client', 'qa'] as const).forEach((role, index) => {
  const actor = ['顾清', '丁禾', '江驰', '余安'][index]!
  store.updateApproval('rel-001', role, 'approved', actor, `按 r11 重新审批通过 ${role}`, 11)
})
check(
  '四角色按最新修订重新审批后门禁通过',
  rel001.approvals.every((a) => !a.invalidatedAt && a.grantedRevision === 11) &&
    store.evidenceReady(rel001),
)

// 消除候选事件的校验扣分（类型变化通过补充最新基线、重复事件停用），使就绪度达到发布线
const nowIso = new Date().toISOString()
;['evt-001', 'evt-003'].forEach((eventId) => {
  const event = store.data.events.find((e) => e.id === eventId)!
  store.data.baselines.unshift({
    id: `base-test-${eventId}`,
    releaseId: 'rel-test-baseline',
    revision: 10,
    eventId,
    version: event.version,
    properties: JSON.parse(JSON.stringify(event.properties)),
    createdAt: nowIso,
    status: 'published',
  })
})
store.data.events.find((e) => e.id === 'evt-005')!.status = 'retired'
check('重新核对与审批后就绪度达到发布线', store.evidenceReady(rel001))

// ---------- 4. 发布冻结修订号与证据 ----------
const baselinesBefore = store.data.baselines.length
const auditBefore = store.data.audit.length
check('发布成功', store.publishRelease('rel-001') === true)
check('冻结修订号为 r11', rel001.frozenRevision === 11 && rel001.status === 'published')
check('冻结完整候选快照（事件+确认+审批证据）', Boolean(rel001.frozenSnapshot) &&
  rel001.frozenSnapshot!.events.length === 3 &&
  rel001.frozenSnapshot!.confirmations.length === confirmationIds.length &&
  rel001.frozenSnapshot!.approvals.length === 4)
check('为候选内事件生成带 releaseId 的基线',
  store.data.baselines.filter((b) => b.releaseId === 'rel-001').length === 3)
check('发布后提交日志已清除', store.data.publishJournals.every((j) => j.releaseId !== 'rel-001'))

// 同一发布重放（模拟重复点击/恢复）不重复生成
store.publishRelease('rel-001')
check('同一修订重放不重复生成基线', store.data.baselines.length === baselinesBefore + 3)
check('同一修订重放不重复生成审计', store.data.audit.length === auditBefore + 1)

// 发布后再改契约，不应改动已冻结发布
store.saveProperty(
  'evt-003',
  { ...evt003.properties.find((p) => p.id === 'prop-014')!, description: '发布后的再次调整' },
  11,
)
check('发布后新修订不覆盖冻结修订', rel001.frozenRevision === 11 && store.data.currentRevision === 12)

// ---------- 5. 回滚：新修订、候选保留、下游重新对账、幂等 ----------
const dep004 = store.data.dependencies.find((d) => d.id === 'dep-004')!
dep004.status = 'migrated' // 模拟下游已迁移
const rollback = store.executeRollback('rel-001', 'Android 端字段格式异常', 'Android 全量', 'RB-EVIDENCE-1', 12)!
check('回滚产生新修订号 r13', rollback?.revision === 13 && store.data.currentRevision === 13)
check('回滚记录与候选共用同一修订号', store.data.rollbacks[0]!.revision === rollback.revision)
check('候选保留且状态为已回滚', rel001.status === 'rolled_back' && rel001.id === 'rel-001')
check('回滚记录含对账字段，初始为已执行', store.data.rollbacks[0]!.status === 'executed')
const rollbackAgain = store.executeRollback('rel-001', '重复回滚', 'x', 'y', 13)
check('同一发布回滚重放幂等（不重复生成记录与修订）', rollbackAgain?.id === rollback.id && store.data.currentRevision === 13)
store.verifyRollback(rollback.id, '指标恢复 RB-VERIFY-1')
check('回滚验证记录对账完成时间', Boolean(store.data.rollbacks[0]!.reconciledAt))

// dep-004 引用 prop-024（已删除），回滚后应重新进入待迁移
check('下游按回滚后契约重新对账（仍引用删除字段 → 待迁移）', dep004.status === 'migration_required')

// ---------- 6. commit 写入失败：从完整候选恢复，且重放幂等 ----------
memory.clear()
store = freshStore()
const revBefore = store.data.currentRevision
setWriteFault('commit')
const created = store.createRelease('2026.11.0', '十一月候选', ['evt-002'], revBefore)
created.migrationConfirmations.forEach((c) =>
  store.confirmMigration(created.id, c.id, c.reviewer || '负责人', '确认迁移', store.data.currentRevision),
)
;(['data', 'product', 'client', 'qa'] as const).forEach((role, index) => {
  const actor = ['顾清', '丁禾', '江驰', '余安'][index]!
  store.updateApproval(created.id, role, 'approved', actor, '审批通过', store.data.currentRevision)
})
let commitFailed = false
try {
  store.publishRelease(created.id)
} catch (error) {
  commitFailed = error instanceof StateWriteError && error.phase === 'commit'
}
check('commit 阶段写入失败被抛出且保留失败日志引用', commitFailed && store.failedPublish !== null)

// 模拟刷新：新 store 初始化时从 prepare 日志的完整候选恢复（崩溃前持久化的基线数不含本次发布）
const persistedRaw = JSON.parse(memory.get('eventrail-governance-v1')!) as {
  baselines: unknown[]
}
const seedBaselineCount = persistedRaw.baselines.length
store = freshStore()
const recovered = store.data.releases.find((r) => r.id === created.id)!
check('刷新后自动从完整候选恢复发布', recovered.status === 'published' && recovered.frozenRevision !== undefined)
check('恢复后基线按修订+事件幂等去重',
  store.data.baselines.filter((b) => b.releaseId === created.id).length === 1 &&
  store.data.baselines.length === seedBaselineCount + 1,
  `release baselines=${store.data.baselines.filter((b) => b.releaseId === created.id).length}, seed=${seedBaselineCount} after=${store.data.baselines.length}`)
check('恢复后提交日志已清除', store.data.publishJournals.length === 0)
check('恢复发布有告知记录', store.recoveredPublishes.length === 1)

// 再次"刷新"不应重复恢复
store = freshStore()
check('同一修订再次加载不重复恢复/不重复生成记录',
  store.data.baselines.filter((b) => b.releaseId === created.id).length === 1 &&
  store.recoveredPublishes.length === 0)

// ---------- 7. prepare 写入失败：发布尚未发生 ----------
memory.clear()
store = freshStore()
setWriteFault('prepare')
const candidate2 = store.createRelease('2026.12.0', '十二月候选', ['evt-002'], store.data.currentRevision)
let prepareFailed = false
try {
  candidate2.migrationConfirmations.forEach((c) =>
    store.confirmMigration(candidate2.id, c.id, '负责人', 'ok', store.data.currentRevision),
  )
  ;(['data', 'product', 'client', 'qa'] as const).forEach((role, index) => {
    const actor = ['顾清', '丁禾', '江驰', '余安'][index]!
    store.updateApproval(candidate2.id, role, 'approved', actor, 'ok', store.data.currentRevision)
  })
  store.publishRelease(candidate2.id)
} catch (error) {
  prepareFailed = error instanceof StateWriteError && error.phase === 'prepare'
}
check('prepare 写入失败时发布尚未发生',
  prepareFailed &&
  store.data.releases.find((r) => r.id === candidate2.id)?.status === 'reviewing')

// 排除故障后重试发布应当成功（同一候选重放，不产生重复记录）
check('故障排除后重试发布成功', store.publishRelease(candidate2.id) === true)
check('重试发布仍冻结当前修订', candidate2.frozenRevision === store.data.currentRevision)
check('成功后日志清空', store.data.publishJournals.length === 0)

// ---------- 8. 导出包含修订号与失效原因 ----------
memory.clear()
store = freshStore()
// 新建候选后再修订契约，制造一个评审中且带失效证据的候选
const exportRelease = store.createRelease('2026.11.0', '十一月候选', ['evt-001'], store.data.currentRevision)
const initialRev = exportRelease.baseRevision
store.saveProperty(
  'evt-001',
  {
    ...store.data.events.find((e) => e.id === 'evt-001')!.properties.find((p) => p.id === 'prop-001')!,
    description: '订单号（导出失效验证修订）',
  },
  initialRev,
)
// 先确认/审批，随后再修订使其失效
const affected = exportRelease.migrationConfirmations
affected.forEach((c, i) => store.confirmMigration(exportRelease.id, c.id, `核对人${i}`, '已核对', store.data.currentRevision))
;(['data', 'product', 'client', 'qa'] as const).forEach((role, i) => {
  const actor = ['顾清', '丁禾', '江驰', '余安'][i]!
  store.updateApproval(exportRelease.id, role, 'approved', actor, '审批通过', store.data.currentRevision)
})
store.savePlatformRule(
  'evt-001',
  {
    ...store.data.events.find((e) => e.id === 'evt-001')!.platformRules[0]!,
    note: '导出失效验证：平台时序补充',
  },
  store.data.currentRevision,
)
const exported = JSON.parse(store.exportContract())
check('JSON 导出包含当前修订号', exported.revision === store.data.currentRevision)
check('JSON 导出包含失效原因与失效证据清单',
  Array.isArray(exported.invalidations) &&
  exported.invalidations.some(
    (item: { release: string; staleApprovals: unknown[]; staleConfirmations: unknown[] }) =>
      item.release === '2026.11.0' &&
      item.staleApprovals.length === 4 &&
      item.staleConfirmations.length === affected.length,
  ),
  JSON.stringify(exported.invalidations))

console.log(`\n全部 ${passed} 项断言通过`)
