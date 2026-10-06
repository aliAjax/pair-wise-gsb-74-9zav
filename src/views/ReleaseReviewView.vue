<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import { reportMutation } from '@/composables/useMutationResult'
import type { ReleaseApproval } from '@/models/domain'
import { releaseReadiness } from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)
const releaseQuery = useReleaseQuery(releaseId)
const release = computed(
  () =>
    releaseQuery.data.value ??
    store.data.releases.find((item) => item.id === releaseId.value) ??
    null,
)
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const readiness = computed(() => (release.value ? releaseReadiness(release.value, store.issues) : 0))
const gateIssueList = computed(() => (release.value ? store.gateIssues(release.value) : []))
const staleConfirmations = computed(
  () =>
    release.value?.migrationConfirmations.filter((item) => item.status === 'invalidated') ?? [],
)
const staleApprovals = computed(
  () => release.value?.approvals.filter((item) => item.status === 'invalidated') ?? [],
)
const revisionStale = computed(
  () =>
    Boolean(release.value) &&
    (release.value!.staleReason?.scopeStale === true ||
      release.value!.scopeRevision < store.data.headRevision),
)

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
})
const migrationForm = reactive({
  confirmationId: '',
  reviewer: '',
  note: '',
})
const selectedApprovalIds = ref<string[]>([])
const approvalComment = ref('')
const singleApproval = ref<ReleaseApproval | null>(null)

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
}

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  const { result, release: created } = store.createRelease(
    createForm.version,
    createForm.title,
    createForm.eventIds,
  )
  if (!(await reportMutation(result)) || !created) return
  releaseId.value = created.id
  createVisible.value = false
  await invalidate()
  await MessagePlugin.success(`发布候选已创建，基准修订 r${created.baseRevision}，已生成下游迁移清单`)
}

const openMigration = (confirmationId: string): void => {
  const confirmation = release.value?.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  // 已失效的确认允许按当前修订重新核对；驳回后也可重新确认
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  const result = store.confirmMigration(
    release.value.id,
    migrationForm.confirmationId,
    migrationForm.reviewer,
    migrationForm.note,
  )
  if (!(await reportMutation(result))) return
  migrationVisible.value = false
  await invalidate()
  await MessagePlugin.success(`下游迁移已按修订 r${store.data.headRevision} 重新确认`)
}

const openApproval = (approval: ReleaseApproval): void => {
  singleApproval.value = approval
  // 失效后重新审批时不沿用旧意见
  approvalComment.value = approval.status === 'invalidated' ? '' : approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  const result = store.updateApproval(
    release.value.id,
    singleApproval.value.role,
    status,
    singleApproval.value.actor,
    approvalComment.value,
  )
  if (!(await reportMutation(result))) return
  approvalVisible.value = false
  await invalidate()
  await MessagePlugin.success(
    status === 'approved'
      ? `审批已按修订 r${store.data.headRevision} 通过`
      : '审批已驳回',
  )
}

const batchApprove = async (): Promise<void> => {
  if (!release.value) return
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  for (const id of selectedApprovalIds.value) {
    const approval = release.value?.approvals.find((item) => item.id === id)
    if (!approval) continue
    const result = store.updateApproval(
      release.value!.id,
      approval.role,
      'approved',
      approval.actor,
      approvalComment.value,
    )
    if (!result.ok) {
      await reportMutation(result)
      break
    }
  }
  selectedApprovalIds.value = []
  approvalComment.value = ''
  await invalidate()
  await MessagePlugin.success('批量审批已提交')
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  const result = store.publishRelease(release.value.id)
  if (!(await reportMutation(result))) return
  await invalidate()
  await MessagePlugin.success(`事件契约已发布，冻结修订 r${release.value.frozenRevision ?? store.data.headRevision}`)
}

const syncScope = async (): Promise<void> => {
  if (!release.value) return
  const result = store.syncReleaseScope(release.value.id)
  if (!(await reportMutation(result))) return
  await invalidate()
  await MessagePlugin.success('候选已同步当前修订，已失效的确认和审批仍需重新核对')
}

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      baseRevision: release.value.baseRevision,
      scopeRevision: release.value.scopeRevision,
      headRevision: store.data.headRevision,
      frozenRevision: release.value.frozenRevision,
      events: release.value.eventIds.map(eventName),
      differences: release.value.differences,
      affectedDependencies: release.value.affectedDependencyIds.map(dependencyName),
      gateIssues: store.gateIssues(release.value),
      migrationConfirmations: release.value.migrationConfirmations.map((confirmation) => ({
        dependency: dependencyName(confirmation.dependencyId),
        status: confirmation.status,
        revision: confirmation.revision,
        invalidatedRevision: confirmation.invalidatedRevision,
        invalidatedReason: confirmation.invalidatedReason,
        reviewer: confirmation.reviewer,
        note: confirmation.note,
      })),
      approvals: release.value.approvals.map((approval) => ({
        role: approval.role,
        actor: approval.actor,
        status: approval.status,
        revision: approval.revision,
        invalidatedRevision: approval.invalidatedRevision,
        invalidatedReason: approval.invalidatedReason,
        comment: approval.comment,
      })),
      frozenEvidence: release.value.frozenEvidence ?? null,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-r${release.value.scopeRevision}-contract-diff.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const setApprovalChecked = (approvalId: string, checked: unknown): void => {
  selectedApprovalIds.value = checked
    ? [...selectedApprovalIds.value, approvalId]
    : selectedApprovalIds.value.filter((id) => id !== approvalId)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="版本差异与发布评审"
      description="比较发布候选契约，生成受影响依赖，要求迁移确认并完成数据、产品、客户端和测试四角色审批。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({ label: `${item.version} ${item.title}`, value: item.id }))"
          />
        </div>
        <div class="filter-actions">
          <t-button variant="outline" :disabled="!release" @click="downloadDiff">
            <template #icon><DownloadIcon /></template>
            导出差异
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <template v-if="release">
      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>修订号</span>
          <strong>
            基准 r{{ release.baseRevision }} / 范围 r{{ release.scopeRevision }}
            <small v-if="revisionStale" class="stale-inline">当前已到 r{{ store.data.headRevision }}</small>
          </strong>
          <small v-if="release.frozenRevision" class="frozen-inline">
            发布冻结 r{{ release.frozenRevision }}
          </small>
        </div>
        <div>
          <span>事件范围</span>
          <strong>{{ release.eventIds.length }} 个</strong>
        </div>
        <div>
          <span>发布就绪度</span>
          <strong>{{ readiness }}%</strong>
        </div>
        <t-button
          theme="primary"
          :disabled="release.status === 'published' || release.status === 'rolled_back'"
          @click="publish"
        >
          发布契约
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>

      <section v-if="release.staleReason?.scopeStale" class="panel sync-banner">
        <div>
          <strong>{{ release.staleReason.reason }}</strong>
          <span>同步后会重新比较差异并补全新受影响下游；已失效的确认与审批不会自动恢复。</span>
        </div>
        <t-button theme="warning" @click="syncScope">同步当前修订</t-button>
      </section>

      <section v-if="gateIssueList.length > 0" class="panel stale-banner">
        <div class="stale-banner-head">
          <CloseCircleIcon />
          <strong>当前修订下存在 {{ gateIssueList.length }} 项待重新核对，发布门禁未通过</strong>
        </div>
        <ul>
          <li v-for="issue in gateIssueList" :key="`${issue.kind}-${issue.targetId}`">
            <StatusTag
              :value="issue.kind === 'stale_confirmation' || issue.kind === 'stale_approval' || issue.kind === 'scope_stale' ? 'invalidated' : 'pending'"
            />
            <strong>{{ issue.label }}</strong>
            <span>{{ issue.reason }}</span>
          </li>
        </ul>
      </section>

      <div class="release-grid">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">契约差异</h2>
            <span class="muted">{{ release.differences.length }} 个事件发生变化</span>
          </div>
          <div class="diff-list">
            <article v-for="difference in release.differences" :key="difference.eventId" class="diff-event">
              <div class="diff-event-head">
                <strong>{{ difference.eventKey }}</strong>
                <span>{{ eventName(difference.eventId) }}</span>
              </div>
              <div class="diff-columns">
                <div class="diff-block">
                  <h4>新增与删除</h4>
                  <ul>
                    <li v-for="item in difference.addedProperties" :key="`add-${item}`">
                      新增属性 {{ item }}
                    </li>
                    <li v-for="item in difference.removedProperties" :key="`remove-${item}`">
                      删除属性 {{ item }}
                    </li>
                  </ul>
                  <span
                    v-if="
                      difference.addedProperties.length === 0 &&
                      difference.removedProperties.length === 0
                    "
                    class="muted"
                  >
                    无属性增删
                  </span>
                </div>
                <div class="diff-block">
                  <h4>兼容性变化</h4>
                  <ul>
                    <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                  </ul>
                  <span
                    v-if="
                      difference.requiredChanges.length === 0 &&
                      difference.typeChanges.length === 0 &&
                      difference.enumChanges.length === 0
                    "
                    class="muted"
                  >
                    无破坏性变化
                  </span>
                </div>
              </div>
            </article>
            <div v-if="release.differences.length === 0" class="empty-state">该版本没有契约差异。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">发布门禁</h2>
          </div>
          <div class="gate-list">
            <div class="gate-row">
              <CheckCircleIcon />
              <div>
                <strong>契约差异已生成</strong>
                <span>{{ release.differences.length }} 个事件参与比较</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: release.migrationConfirmations.some(
                    (item) =>
                      release?.affectedDependencyIds.includes(item.dependencyId) &&
                      item.status !== 'confirmed',
                  ),
                }"
              />
              <div>
                <strong>下游迁移确认</strong>
                <span>
                  {{
                    release.migrationConfirmations.filter(
                      (item) =>
                        release?.affectedDependencyIds.includes(item.dependencyId) &&
                        item.status === 'confirmed',
                    ).length
                  }}/{{ release.affectedDependencyIds.length }} 已确认
                  <em v-if="staleConfirmations.length > 0" class="stale-text">
                    （{{ staleConfirmations.length }} 项已失效）
                  </em>
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{ pending: release.approvals.some((item) => item.status !== 'approved') }"
              />
              <div>
                <strong>四角色批量审批</strong>
                <span>
                  {{ release.approvals.filter((item) => item.status === 'approved').length }}/{{
                    release.approvals.length
                  }}
                  已通过
                  <em v-if="staleApprovals.length > 0" class="stale-text">
                    （{{ staleApprovals.length }} 项已失效）
                  </em>
                </span>
              </div>
            </div>
            <div class="readiness">
              <span>综合就绪度</span>
              <strong>{{ readiness }}%</strong>
              <t-progress :percentage="readiness" :label="false" />
            </div>
          </div>
        </section>
      </div>

      <section v-if="release.frozenEvidence" class="panel frozen-panel">
        <div class="panel-header">
          <h2 class="panel-title">发布冻结证据</h2>
          <span class="muted">
            冻结修订 r{{ release.frozenEvidence.revision }} ·
            {{ new Date(release.frozenEvidence.frozenAt).toLocaleString('zh-CN') }}
          </span>
        </div>
        <div class="frozen-grid">
          <div>
            <strong>迁移确认（{{ release.frozenEvidence.migrationConfirmations.length }}）</strong>
            <ul>
              <li v-for="item in release.frozenEvidence.migrationConfirmations" :key="item.dependencyId">
                {{ dependencyName(item.dependencyId) }} · {{ item.reviewer }} · r{{ item.revision ?? '?' }}
              </li>
            </ul>
          </div>
          <div>
            <strong>四角色审批（{{ release.frozenEvidence.approvals.length }}）</strong>
            <ul>
              <li v-for="item in release.frozenEvidence.approvals" :key="item.role">
                {{ roleLabel(item.role) }} · {{ item.actor }} · r{{ item.revision ?? '?' }}
              </li>
            </ul>
          </div>
        </div>
      </section>

      <div class="review-columns">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">下游迁移确认</h2>
          </div>
          <div class="migration-list">
            <article
              v-for="confirmation in release.migrationConfirmations"
              :key="confirmation.id"
              class="migration-card"
              :class="{ invalid: confirmation.status === 'invalidated' }"
            >
              <div>
                <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                <span>{{ confirmation.reviewer || '未指定确认人' }}</span>
              </div>
              <StatusTag :value="confirmation.status" />
              <p>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
              <dl v-if="confirmation.status === 'invalidated'" class="invalid-reason">
                <dt>失效原因</dt>
                <dd>{{ confirmation.invalidatedReason }}</dd>
                <dt>失效修订</dt>
                <dd>r{{ confirmation.invalidatedRevision }}（原确认基于 r{{ confirmation.revision ?? '?' }}）</dd>
              </dl>
              <small v-else-if="confirmation.status === 'confirmed'" class="evidence-revision">
                确认基于修订 r{{ confirmation.revision ?? '?' }}
              </small>
              <t-button
                variant="outline"
                size="small"
                @click="openMigration(confirmation.id)"
              >
                {{ confirmation.status === 'invalidated' ? '按当前修订重新核对' : '确认迁移' }}
              </t-button>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批</h2>
          </div>
          <div class="approval-list">
            <label
              v-for="approval in release.approvals"
              :key="approval.id"
              class="approval-row"
              :class="{ invalid: approval.status === 'invalidated' }"
            >
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="approval.status === 'approved'"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>{{ roleLabel(approval.role) }}</strong>
                <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
                <small v-if="approval.status === 'invalidated'" class="invalid-reason-text">
                  {{ approval.invalidatedReason }}
                </small>
                <small v-else-if="approval.status === 'approved'" class="evidence-revision">
                  审批基于修订 r{{ approval.revision ?? '?' }}
                </small>
              </div>
              <StatusTag :value="approval.status" />
              <t-button variant="text" size="small" @click.prevent="openApproval(approval)">
                {{ approval.status === 'invalidated' ? '重新审批' : '审批' }}
              </t-button>
            </label>
          </div>
          <div class="batch-bar">
            <t-input v-model="approvalComment" placeholder="批量审批意见" />
            <t-button theme="primary" @click="batchApprove">批量通过</t-button>
          </div>
        </section>
      </div>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选" width="720px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>版本号</label>
          <t-input v-model="createForm.version" />
        </div>
        <div class="field">
          <label>发布标题</label>
          <t-input v-model="createForm.title" />
        </div>
        <div class="field field-wide">
          <label>参与发布的事件</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({
                  label: `${event.displayName} (${event.key})`,
                  value: event.id,
                }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createRelease">创建并比较</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="确认下游迁移" width="620px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>确认人</label>
          <t-input v-model="migrationForm.reviewer" />
        </div>
        <div class="field field-wide">
          <label>迁移说明</label>
          <t-textarea v-model="migrationForm.note" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="migrationVisible = false">取消</t-button>
        <t-button theme="primary" @click="confirmMigration">确认迁移</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="approvalVisible" header="提交审批" width="620px" :footer="false">
      <div v-if="singleApproval" class="selected-approval">
        <strong>{{ roleLabel(singleApproval.role) }}</strong>
        <span>{{ singleApproval.actor }}</span>
      </div>
      <div class="field">
        <label>审批意见</label>
        <t-textarea v-model="approvalComment" :autosize="{ minRows: 5, maxRows: 8 }" />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="approvalVisible = false">取消</t-button>
        <t-button theme="danger" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitApproval('approved')">
          <template #icon><CheckCircleIcon /></template>
          通过
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.release-field {
  min-width: 390px;
}

.release-overview {
  display: grid;
  grid-template-columns: 180px minmax(260px, 1fr) 130px 140px auto;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.stale-inline,
.frozen-inline {
  display: block;
  color: #b42318;
  font-size: 11px;
}

.frozen-inline {
  color: #0e7a58;
}

.stale-banner {
  margin-top: 16px;
  border-color: #f2c4c0;
  background: #fff7f6;
}

.sync-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
  border-color: #e8d9b5;
  background: #fdf8ec;
}

.sync-banner div {
  display: grid;
  gap: 4px;
}

.sync-banner strong {
  color: #8a6116;
  font-size: 12px;
}

.sync-banner span {
  color: #8f7c52;
  font-size: 11px;
}

.stale-banner-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: #a81f17;
}

.stale-banner-head svg {
  color: #c44034;
}

.stale-banner ul {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.stale-banner li {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.stale-banner li span {
  color: #7a5a56;
}

.stale-text {
  color: #b42318 !important;
  font-style: normal;
}

.migration-card.invalid,
.approval-row.invalid {
  background: #fff7f6;
}

.invalid-reason {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0;
  padding: 10px 12px;
  border-left: 3px solid #d24a3e;
  background: #fdecea;
  font-size: 11px;
}

.invalid-reason dt {
  color: #a81f17;
  font-weight: 600;
}

.invalid-reason dd {
  margin: 0;
  color: #6b4c48;
}

.invalid-reason-text,
.evidence-revision {
  color: #b42318;
  font-size: 10px;
}

.evidence-revision {
  color: #0e7a58;
}

.frozen-panel .frozen-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  padding: 14px 16px;
}

.frozen-grid ul {
  margin: 8px 0 0;
  padding-left: 18px;
  color: #596579;
  font-size: 12px;
  line-height: 1.9;
}

.release-overview > div,
.release-overview > button {
  align-self: stretch;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.release-overview > button {
  border-radius: 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
}

.diff-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.diff-event {
  padding: 16px;
  background: #fff;
}

.diff-event-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.diff-event-head strong {
  font-family: monospace;
  font-size: 12px;
}

.diff-event-head span {
  color: #737e90;
  font-size: 11px;
}

.gate-list {
  padding: 10px 16px 18px;
}

.gate-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.gate-row svg {
  color: #0f8a62;
}

.gate-row svg.pending {
  color: #c46a00;
}

.gate-row > div {
  display: grid;
  gap: 4px;
}

.gate-row strong {
  font-size: 12px;
}

.gate-row span,
.readiness span {
  color: #727d8f;
  font-size: 11px;
}

.readiness {
  display: grid;
  gap: 7px;
  padding-top: 16px;
}

.readiness strong {
  font-size: 24px;
}

.review-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.migration-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.migration-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.migration-card > div {
  display: grid;
  gap: 4px;
}

.migration-card span,
.migration-card p {
  color: #6d788b;
  font-size: 11px;
}

.migration-card p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.5;
}

.migration-card :deep(.t-button) {
  grid-column: 1 / -1;
  justify-self: start;
}

.approval-list {
  display: grid;
  padding: 6px 16px;
}

.approval-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
  cursor: pointer;
}

.approval-row > div {
  display: grid;
  gap: 4px;
}

.approval-row span {
  color: #717c8e;
  font-size: 11px;
}

.batch-bar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8ebef;
}

.selected-approval {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #fafbfc;
}

.selected-approval span {
  color: #717c8e;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>
