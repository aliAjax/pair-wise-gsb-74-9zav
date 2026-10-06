# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 数据、产品、客户端和测试四角色批量审批与发布门禁
- 事件废弃计划、替代事件和迁移说明
- 发布回滚记录与结果验证
- JSON 契约和 Markdown 契约文档导出

## 修订号（revision）并发与失效模型

候选、契约修订和回滚记录共用一个单调递增的全局修订号 `rN`（`GovernanceState.currentRevision`）。

- 事件、属性（含删除标记）或平台规则任一发生实质变化（按事件契约指纹判定）即推进修订号；无内容变化的保存不产生新修订。
- 修订会刷新覆盖相关事件的评审中候选：旧迁移确认与四角色审批保留历史但标记为「已失效」并记录失效原因，受影响下游（属性差异命中与直接订阅候选事件的依赖取并集）回到待迁移；重新核对、重新审批后才可发布。
- 候选记录创建时盖 `baseRevision`，随契约修订推进 `contractRevision`；发布时冻结 `frozenRevision` 与完整候选快照（事件契约、迁移确认证据、四角色审批证据）。
- 多窗口编辑通过修订号乐观锁防护：编辑器携带打开时的修订号，其他窗口先写入后，迟到的旧修订提交抛出 `RevisionConflictError` 被拒绝；窗口间通过 `storage` 事件自动同步最新修订。
- 发布为两阶段提交：先写含完整候选快照的 `prepared` 日志，再提交结果。`prepare` 失败发布未发生可重试；`commit` 失败后刷新页面会自动从冻结候选幂等恢复，页面也提供「从冻结候选恢复」入口；同一修订重放按「修订+事件」去重，不重复生成基线与审计。
- 回滚同样产生新修订号，回滚记录与候选共用同一序列；候选保留，覆盖范围内评审候选的确认/审批失效，下游按回滚后契约重新对账（仍引用删除字段的回到待迁移），验证时再次对账。回滚重放按发布幂等。
- 发布评审页、事件树、工作台、回滚页和 JSON/Markdown 导出均显示修订号与失效原因。
- 发布评审页工具栏提供「故障演练」开关，可分别模拟 prepare / commit 写入失败以验证恢复路径。

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃和回滚状态
- `src/services/selectors.ts`：契约比较、影响分析和校验规则
