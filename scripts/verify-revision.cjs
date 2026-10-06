/* 逻辑验证：修订号串联、失效传播、OCC、WAL 恢复幂等、回滚对账 */
const assert = require('node:assert')
const esbuild = require('esbuild')
const path = require('node:path')

;(async () => {
const result = await esbuild.build({
  entryPoints: [path.join(__dirname, 'scenario-entry.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  alias: { '@': path.join(__dirname, '..', 'src') },
})

const code = result.outputFiles[0].text
const moduleObj = { exports: {} }
new Function('module', 'exports', 'require', code)(moduleObj, moduleObj.exports, require)
const scenario = moduleObj.exports

// 1. 修订号在候选/契约/回滚间共用且单调递增
const state0 = scenario.freshState()
const head0 = state0.headRevision
scenario.editPlatformRule(state0, 'evt-003', 'rule-011', 'Android 补报 15 分钟')
assert.strictEqual(state0.headRevision, head0 + 1, '契约修改应推进修订号')
const revContract = state0.revisions[state0.revisions.length - 1]
assert.strictEqual(revContract.kind, 'contract')
assert.strictEqual(revContract.eventId, 'evt-003')

// 2. 契约变化使相交候选中已确认的迁移与已通过的审批失效，记录原因
const rel = state0.releases.find((r) => r.id === 'rel-001')
const mig004 = rel.migrationConfirmations.find((m) => m.dependencyId === 'dep-004')
assert.strictEqual(mig004.status, 'invalidated', '受影响下游确认应失效')
assert.ok(mig004.invalidatedReason.includes(`r${head0 + 1}`), '应记录失效修订原因')
const approvedRoles = rel.approvals.filter((a) => a.status === 'approved')
assert.strictEqual(approvedRoles.length, 0, '候选范围内四角色审批都应失效')
assert.ok(rel.approvals.every((a) => a.status !== 'invalidated' || a.invalidatedRevision === head0 + 1))

// 不相关候选（已发布）不受影响
const published = state0.releases.find((r) => r.id === 'rel-000')
assert.strictEqual(published.status, 'published')
assert.ok(published.approvals.every((a) => a.status === 'approved'), '已发布候选证据必须冻结不受影响')

// 3. 失效后门禁阻止发布；全部重新核对后放行
const gateBefore = scenario.gate(rel)
assert.ok(gateBefore.length > 0, '存在失效项时门禁必须拦截')
scenario.reconfirmAll(state0, rel)
assert.strictEqual(scenario.gate(rel).length, 0, '重新确认/审批后门禁应清空')

// 4. 发布冻结当前修订与证据
const frozenRev = state0.headRevision
const { baselinesBefore, result: publishResult } = scenario.publishViaWal(state0, rel.id)
assert.strictEqual(publishResult.cleared, true, '提交成功后 WAL 必须清除')
assert.strictEqual(rel.status, 'published')
assert.strictEqual(rel.frozenRevision, frozenRev, '发布应冻结当前修订')
assert.strictEqual(rel.frozenEvidence.approvals.length, 4, '冻结四角色审批证据')
assert.strictEqual(rel.frozenEvidence.migrationConfirmations.length, rel.migrationConfirmations.length)
assert.ok(
  state0.baselines.length === baselinesBefore + rel.eventIds.length,
  '每个事件生成一条基线快照',
)

// 同一发布重放：不重复生成基线/记录
const baselinesAfterFirst = state0.baselines.length
scenario.replayPending(state0, publishResult.operation)
assert.strictEqual(state0.baselines.length, baselinesAfterFirst, '同一修订重放不得重复生成基线')

// 5. 写入失败恢复：完整候选快照恢复发布
const state1 = scenario.freshState()
const target = state1.releases.find((r) => r.id === 'rel-001')
scenario.reconfirmAll(state1, target)
const operation = scenario.stagePublish(state1, target.id)
// 模拟主状态写入彻底失败：重新从存储读取（不含发布结果），但 WAL 已落盘
const recoveredState = scenario.loadWithPending([operation])
const recovered = recoveredState.releases.find((r) => r.id === target.id)
assert.strictEqual(recovered.status, 'published', '应从完整候选恢复发布')
assert.strictEqual(recovered.frozenRevision, operation.intendedRevision, '恢复后冻结修订正确')
assert.ok(recovered.frozenEvidence, '恢复后应带回冻结证据')

// 恢复幂等：再次启动不会重复
const secondLoad = scenario.loadWithPending([])
assert.strictEqual(secondLoad.releases.filter((r) => r.status === 'published').length, 2)

// 6. 回滚：共用修订号、当前候选保留、下游按回滚后契约重新对账
const state2 = scenario.freshState()
const publishedRel = state2.releases.find((r) => r.id === 'rel-000')
const headBeforeRollback = state2.headRevision
const rollback = scenario.rollback(state2, publishedRel.id)
assert.strictEqual(rollback.revision, headBeforeRollback + 1, '回滚必须推进共用修订号')
assert.strictEqual(state2.headRevision, headBeforeRollback + 1)
assert.strictEqual(publishedRel.status, 'rolled_back')
assert.ok(
  state2.releases.some((r) => r.id === 'rel-001'),
  '回滚后其他当前候选必须保留',
)
assert.ok(rollback.reconciliation.length >= 2, '应对发布范围内下游重新对账')
const dep002 = state2.dependencies.find((d) => d.id === 'dep-002')
assert.strictEqual(dep002.status, 'active', '引用完整的下游对账后回到 active')

// 同一回滚重放不重复生成记录
const rollbackCount = state2.rollbacks.length
const again = scenario.rollback(state2, publishedRel.id)
assert.strictEqual(state2.rollbacks.length, rollbackCount, '同修订回滚重放不得重复生成记录')
assert.strictEqual(again.id, rollback.id)

// 回滚也使相交评审候选的旧审批失效
const openRel = state2.releases.find((r) => r.id === 'rel-001')
assert.ok(openRel.approvals.every((a) => a.status !== 'approved'), '回滚后旧审批必须失效')

// 7. 迟到旧修订不能盖住新修订（OCC CAS）
const state3 = scenario.freshState()
const windowA = structuredClone(state3)
const windowB = structuredClone(state3) // B 在 A 提交前就持有同一份旧快照
scenario.editPlatformRule(windowA, 'evt-003', 'rule-011', '窗口 A 修改')
const committedA = scenario.tryCommit(state3, windowA)
assert.strictEqual(committedA.ok, true)
scenario.editPlatformRule(windowB, 'evt-002', 'rule-005', '窗口 B 的迟到修改')
const committedB = scenario.tryCommit(state3, windowB)
assert.strictEqual(committedB.ok, false)
assert.strictEqual(committedB.conflict, true, '旧 stateVersion 的提交必须被 CAS 拒绝')
assert.ok(
  state3.revisions.some((r) => r.summary.includes('窗口 A 修改')),
  '新修订必须保留',
)
assert.ok(
  !state3.revisions.some((r) => r.summary.includes('窗口 B 的迟到修改')),
  '迟到旧修订不能盖住新修订',
)

console.log('全部逻辑断言通过 ✅')

})().catch((error) => { console.error(error); process.exit(1) })
