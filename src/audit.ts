import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type { RuntimeToggles } from './config'

/**
 * 审计双通道（SPEC §10）：
 * - review：每次处理一行 JSON，默认开（permissionReviewLog）
 * - debug：verbose，仅 debugLog 开启时写
 *
 * 说明：SPEC 未指定日志落盘位置，这里固定为
 * `~/.pi/agent/logs/pi-permission-{review,debug}.log`（追加写，每次一行）。
 */

const LOG_DIR = resolve(homedir(), '.pi/agent/logs')
const REVIEW_LOG = resolve(LOG_DIR, 'pi-permission-review.log')
const DEBUG_LOG = resolve(LOG_DIR, 'pi-permission-debug.log')

/** debug 通道的超长内容截断上限 */
const DEBUG_LINE_LIMIT = 4000

export interface Audit {
  /** 记录一条决策（review 通道，单行） */
  review: (data: Record<string, unknown>) => void
  /** 记录一条 debug 明细（verbose） */
  debug: (data: Record<string, unknown>) => void
}

function append(file: string, data: Record<string, unknown>): void {
  try {
    appendFileSync(file, JSON.stringify(data) + '\n')
  } catch {
    // 日志失败不得影响门禁本身
  }
}

/** 创建一个审计句柄；getToggles 为活引用读取器，热重载/运行时开关变化后即时生效 */
export function createAudit(getToggles: () => RuntimeToggles): Audit {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    // 目录失败不影响决策，只是没有日志
  }
  return {
    review: (data) => {
      if (getToggles().permissionReviewLog) append(REVIEW_LOG, data)
    },
    debug: (data) => {
      if (getToggles().debugLog) append(DEBUG_LOG, data)
    }
  }
}

/** debug 字符串截断，避免日志被超长输入撑爆 */
export function truncate(s: string, limit = DEBUG_LINE_LIMIT): string {
  return s.length <= limit ? s : s.slice(0, limit) + `…(截断 ${s.length - limit} 字符)`
}
