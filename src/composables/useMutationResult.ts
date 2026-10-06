import { MessagePlugin } from 'tdesign-vue-next'
import type { MutationResult } from '@/stores/governance'

/** 统一处理 OCC 提交结果：冲突时提示已基于其他窗口的新修订回退 */
export const reportMutation = async (result: MutationResult): Promise<boolean> => {
  if (result.ok) return true
  if (result.conflict) {
    await MessagePlugin.error(`${result.message}，页面已同步到最新修订`)
  } else {
    await MessagePlugin.error(result.message)
  }
  return false
}
