<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  HistoryIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import type { ReleaseApproval } from '@/models/domain'
import {
  isApprovalValid,
  isConfirmationValid,
  RevisionConflictError,
} from '@/services/revision'
import { releaseReadiness } from '@/services/selectors'
import { getWriteFault, setWriteFault, StateWriteError } from '@/services/repository'
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
const currentRevision = computed(() => store.data.currentRevision)
const isStale = computed(
  () =>
    Boolean(release.value) &&
    release.value!.status === 'reviewing' &&
    release.value!.contractRevision < currentRevision.value,
)
const staleConfirmations = computed(
  () => release.value?.migrationConfirmations.filter((item) => item.invalidatedAt) ?? [],
)
const staleApprovals = computed(
  () => release.value?.approvals.filter((item) => item.invalidatedAt) ?? [],
)
const faultMode = ref<'prepare' | 'commit' | ''>(getWriteFault())

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
const formatTime = (value?: string): string =>
  value ? new Date(value).toLocaleString('zh-CN') : '—'

const conflictMessage = (error: unknown, fallback: string): string =>
  error instanceof RevisionConflictError
    ? `${error.message}，请刷新页面基于最新修订重新操作`
    : error instanceof StateWriteError
      ? error.message
      : fallback

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
  try {
    const created = store.createRelease(
      createForm.version,
      createForm.title,
      createForm.eventIds,
      currentRevision.value,
    )
    releaseId.value = created.id
    createVisible.value = false
    await invalidate()
    await MessagePlugin.success(`发布候选已创建于 r${created.baseRevision}，已生成下游迁移清单`)
  } catch (error) {
    await MessagePlugin.error(conflictMessage(error, '创建发布候选失败'))
  }
}

const openMigration = (confirmationId: string): void => {
  const confirmation = release.value?.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.invalidatedAt ? '' : confirmation.note
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  try {
    store.confirmMigration(
      release.value.id,
      migrationForm.confirmationId,
      migrationForm.reviewer,
      migrationForm.note,
      currentRevision.value,
    )
    migrationVisible.value = false
    await invalidate()
    await MessagePlugin.success(`已基于 r${currentRevision.value} 重新核对并确认迁移`)
  } catch (error) {
    await MessagePlugin.error(conflictMessage(error, '迁移确认失败'))
  }
}

const openApproval = (approval: ReleaseApproval): void => {
  singleApproval.value = approval
  approvalComment.value = approval.invalidatedAt ? '' : approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  try {
    store.updateApproval(
      release.value.id,
      singleApproval.value.role,
      status,
      singleApproval.value.actor,
      approvalComment.value,
      currentRevision.value,
    )
    approvalVisible.value = false
    await invalidate()
    await MessagePlugin.success(
      status === 'approved'
        ? `已基于 r${currentRevision.value} 重新审批通过`
        : '审批已驳回',
    )
  } catch (error) {
    await MessagePlugin.error(conflictMessage(error, '审批提交失败'))
  }
}

const batchApprove = async (): Promise<void> => {
  if (!release.value) return
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  try {
    selectedApprovalIds.value.forEach((id) => {
      const approval = release.value?.approvals.find((item) => item.id === id)
      if (approval) {
        store.updateApproval(
          release.value!.id,
          approval.role,
          'approved',
          approval.actor,
          approvalComment.value,
          currentRevision.value,
        )
      }
    })
    selectedApprovalIds.value = []
    approvalComment.value = ''
    await invalidate()
    await MessagePlugin.success(`批量审批已按 r${currentRevision.value} 提交`)
  } catch (error) {
    await MessagePlugin.error(conflictMessage(error, '批量审批失败'))
  }
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  if (isStale.value || staleConfirmations.value.length > 0 || staleApprovals.value.length > 0) {
    await MessagePlugin.error('候选基于旧修订：请先完成下游重新核对与四角色重新审批')
    return
  }
  try {
    if (!store.publishRelease(release.value.id)) {
      await MessagePlugin.error('迁移确认或四角色审批尚未完成，当前不可发布')
      return
    }
    await invalidate()
    await MessagePlugin.success(
      `事件契约已发布，冻结 r${release.value.frozenRevision} 及全部确认证据`,
    )
  } catch (error) {
    await invalidate()
    if (error instanceof StateWriteError && error.phase === 'prepare') {
      await MessagePlugin.error('发布提交日志写入失败，发布尚未开始，可稍后重试')
    } else {
      await MessagePlugin.error(
        `${conflictMessage(error, '发布结果写入失败')}；完整候选已冻结，刷新页面或点击“从冻结候选恢复”可继续`,
      )
    }
  }
}

const recoverFailed = async (): Promise<void> => {
  if (!store.failedPublish) return
  store.recoverFailedPublish()
  releaseId.value = store.failedPublish?.releaseId ?? releaseId.value
  await invalidate()
  await MessagePlugin.success('已从冻结的完整候选恢复发布结果（同一修订重放，未重复生成记录）')
}

const setFaultMode = (value: unknown): void => {
  const mode = value as 'prepare' | 'commit' | ''
  faultMode.value = mode
  setWriteFault(mode)
}

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      baseRevision: release.value.baseRevision,
      contractRevision: release.value.contractRevision,
      currentRevision: currentRevision.value,
      frozenRevision: release.value.frozenRevision ?? null,
      staleReason: release.value.staleReason ?? null,
      events: release.value.eventIds.map(eventName),
      differences: release.value.differences,
      affectedDependencies: release.value.affectedDependencyIds.map(dependencyName),
      migrationConfirmations: release.value.migrationConfirmations,
      approvals: release.value.approvals,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-r${release.value.contractRevision}-contract-diff.json`
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

    <section v-if="store.externalUpdateAt" class="panel sync-banner">
      <HistoryIcon />
      <div>
        <strong>其他浏览器窗口已写入更新修订（当前 r{{ currentRevision }}）</strong>
        <span>本窗口的旧修订操作会被拒绝，页面数据已同步为最新契约。</span>
      </div>
    </section>

    <section v-if="store.failedPublish" class="panel recovery-banner">
      <CloseCircleIcon />
      <div>
        <strong>
          发布结果写入失败：{{ store.failedPublish.candidate.version }}（冻结 r{{
            store.failedPublish.revision
          }}）
        </strong>
        <span>完整候选与确认证据已在提交日志中冻结，恢复不会重复生成发布记录。</span>
      </div>
      <t-button theme="danger" size="small" @click="recoverFailed">从冻结候选恢复</t-button>
    </section>

    <section v-if="store.recoveredPublishes.length" class="panel recovered-banner">
      <CheckCircleIcon />
      <div>
        <strong>
          已从写入失败中恢复 {{ store.recoveredPublishes.length }} 个发布（r{{
            store.recoveredPublishes.map((item) => item.revision).join('、')
          }}）
        </strong>
        <span>恢复按同一修订重放，基线与审计均已幂等去重。</span>
      </div>
      <t-button variant="text" size="small" @click="store.dismissRecoveryNotice()">知道了</t-button>
    </section>

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({
              label: `${item.version} r${item.contractRevision} ${item.title}`,
              value: item.id,
            }))"
          />
        </div>
        <div class="filter-actions">
          <t-select
            :value="faultMode"
            class="fault-select"
            @change="setFaultMode"
            :options="[
              { label: '故障演练：关闭', value: '' },
              { label: '故障演练：prepare 写入失败', value: 'prepare' },
              { label: '故障演练：commit 写入失败', value: 'commit' },
            ]"
          />
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
      <section v-if="release.staleReason && release.status === 'reviewing'" class="panel stale-banner">
        <CloseCircleIcon />
        <div>
          <strong>候选基于过期修订：候选 r{{ release.contractRevision }} / 当前 r{{ currentRevision }}</strong>
          <span>{{ release.staleReason }}</span>
          <span v-if="staleConfirmations.length || staleApprovals.length">
            {{ staleConfirmations.length }} 项迁移确认与 {{ staleApprovals.length }}
            项角色审批已失效，相关下游重新核对、四角色重新审批后才能发布。
          </span>
        </div>
      </section>

      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>修订号</span>
          <strong>
            r{{ release.contractRevision }}
            <small v-if="release.frozenRevision"> / 冻结 r{{ release.frozenRevision }}</small>
            <small v-else-if="release.baseRevision !== release.contractRevision">
              （基线 r{{ release.baseRevision }}）
            </small>
          </strong>
          <StatusTag v-if="isStale" value="stale" />
        </div>
        <div>
          <span>标题 / 事件范围</span>
          <strong>{{ release.title }}</strong>
          <small>{{ release.eventIds.length }} 个事件</small>
        </div>
        <div>
          <span>发布就绪度</span>
          <strong :class="{ 'readiness-blocked': isStale }">{{ readiness }}%</strong>
        </div>
        <t-button
          theme="primary"
          :disabled="
            release.status === 'published' ||
            release.status === 'rolled_back' ||
            isStale ||
            staleConfirmations.length > 0 ||
            staleApprovals.length > 0
          "
          @click="publish"
        >
          {{ release.frozenRevision ? '已冻结发布' : '发布契约' }}
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>
      <p v-if="release.frozenAt" class="frozen-note">
        发布时间 {{ formatTime(release.frozenAt) }}：已冻结 r{{ release.frozenRevision }}
        的完整契约与 {{ release.frozenSnapshot?.confirmations.length ?? 0 }} 项迁移证据、
        {{ release.frozenSnapshot?.approvals.length ?? 0 }} 项审批证据。
      </p>

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
                    (item) => !isConfirmationValid(item),
                  ),
                }"
              />
              <div>
                <strong>下游迁移确认（按最新修订重新核对）</strong>
                <span>
                  {{ release.migrationConfirmations.filter((item) => isConfirmationValid(item)).length
                  }}/{{ release.migrationConfirmations.length }} 有效确认
                  <template v-if="staleConfirmations.length">
                    · {{ staleConfirmations.length }} 项已失效
                  </template>
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{ pending: release.approvals.some((item) => !isApprovalValid(item)) }"
              />
              <div>
                <strong>四角色批量审批（修订变更后重新审批）</strong>
                <span>
                  {{ release.approvals.filter((item) => isApprovalValid(item)).length }}/{{
                    release.approvals.length
                  }}
                  有效通过
                  <template v-if="staleApprovals.length">
                    · {{ staleApprovals.length }} 项已失效
                  </template>
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
              :class="{ invalid: confirmation.invalidatedAt }"
            >
              <div>
                <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                <span>
                  {{ confirmation.reviewer || '未指定确认人' }}
                  <template v-if="confirmation.grantedRevision !== undefined">
                    · 基于 r{{ confirmation.grantedRevision }} 核对
                  </template>
                </span>
              </div>
              <StatusTag :value="confirmation.invalidatedAt ? 'invalidated' : confirmation.status" />
              <p>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
              <div v-if="confirmation.invalidatedAt" class="invalid-reason">
                <CloseCircleIcon />
                <div>
                  <strong>失效原因</strong>
                  <span>{{ confirmation.invalidatedReason }}</span>
                  <small>失效于 {{ formatTime(confirmation.invalidatedAt) }}，请按当前契约重新核对</small>
                </div>
              </div>
              <t-button
                variant="outline"
                size="small"
                :theme="confirmation.invalidatedAt ? 'primary' : 'default'"
                :disabled="!confirmation.invalidatedAt && confirmation.status === 'confirmed'"
                @click="openMigration(confirmation.id)"
              >
                {{ confirmation.invalidatedAt ? '按最新修订重新核对' : '确认迁移' }}
              </t-button>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批</h2>
            <span v-if="staleApprovals.length" class="muted danger-text">
              {{ staleApprovals.length }} 项审批被新修订作废
            </span>
          </div>
          <div class="approval-list">
            <label v-for="approval in release.approvals" :key="approval.id" class="approval-row">
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="isApprovalValid(approval)"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>
                  {{ roleLabel(approval.role) }}
                  <small v-if="approval.grantedRevision !== undefined">
                    （r{{ approval.grantedRevision }}）
                  </small>
                </strong>
                <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
                <small v-if="approval.invalidatedAt" class="danger-text">
                  失效：{{ approval.invalidatedReason }}
                </small>
              </div>
              <StatusTag :value="approval.invalidatedAt ? 'invalidated' : approval.status" />
              <t-button variant="text" size="small" @click.prevent="openApproval(approval)">
                {{ approval.invalidatedAt ? '重新审批' : '审批' }}
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
.sync-banner,
.recovery-banner,
.recovered-banner,
.stale-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  padding: 12px 16px;
  border-radius: 6px;
}

.sync-banner {
  border: 1px solid #bcd3f2;
  background: #f2f7ff;
}

.sync-banner svg {
  color: #1264c5;
}

.recovery-banner {
  justify-content: space-between;
  border: 1px solid #f2b8b5;
  background: #fff4f3;
}

.recovery-banner svg {
  color: #c02a1d;
}

.recovered-banner {
  justify-content: space-between;
  border: 1px solid #b7e4d2;
  background: #f0fbf6;
}

.recovered-banner svg {
  color: #0f8a62;
}

.stale-banner {
  border: 1px solid #f0d5ad;
  background: #fff8ef;
}

.stale-banner svg {
  color: #c46a00;
}

.sync-banner > div,
.recovery-banner > div,
.recovered-banner > div,
.stale-banner > div {
  display: grid;
  gap: 3px;
}

.sync-banner span,
.recovery-banner span,
.recovered-banner span,
.stale-banner span {
  color: #66728a;
  font-size: 12px;
}

.filter-panel {
  padding: 14px 16px;
}

.fault-select {
  width: 220px;
}

.release-field {
  min-width: 390px;
}

.release-overview small {
  color: #8893a5;
  font-size: 11px;
  font-weight: 400;
}

.readiness-blocked {
  color: #c46a00;
}

.frozen-note {
  margin: -6px 0 14px;
  color: #0f8a62;
  font-size: 12px;
}

.migration-card.invalid {
  background: #fff9f4;
}

.invalid-reason {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 4px;
  background: #fdf0e3;
}

.invalid-reason svg {
  color: #c46a00;
}

.invalid-reason div {
  display: grid;
  gap: 2px;
}

.invalid-reason span,
.invalid-reason small {
  color: #8a5a22;
  font-size: 11px;
  line-height: 1.5;
}

.danger-text {
  color: #c02a1d !important;
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
