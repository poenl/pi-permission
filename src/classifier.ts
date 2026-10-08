import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { ClassifierConfig } from './config'
import type { Contribution, Decision } from './engine'

/**
 * classify 面解析（SPEC §6）。
 *
 * - 模型：从 pi 模型注册表按 classifier 块的 provider/model 取
 *   classifier 类型模型；取不到 → `ask`
 * - 问题：单个 choice（allow / deny / unsure）；state 只含判定所需：真实工具名、
 *   工作目录，加上要判的东西（bash 面给完整命令，其余面给命中的对象）
 * - 阈值：命中 choice 的概率 ≥ threshold 才采用，否则 → `ask`
 * - 超时：按 timeoutMs 中断（Promise.race）
 * - 缓存：会话内按「面 + 内容」缓存
 * - 兜底：任何异常（无模型、鉴权失败、超时、解析失败）→ `ask`，绝不放行
 */

/** classify 结果的会话内缓存：key = `${face}\u0000${subject}` */
export type ClassifyCache = Map<string, Decision>

/** classify 附加上下文：真实工具名 + 完整命令（bash 面） */
export interface ClassifyInfo {
  toolName: string
  command?: string
}

/** 对一条 classify 命中进行解析（带缓存） */
export async function classifyContribution(
  ctx: ExtensionContext,
  cfg: ClassifierConfig | undefined,
  cache: ClassifyCache,
  c: Contribution,
  info: ClassifyInfo
): Promise<Decision> {
  const key = `${c.face}\u0000${c.subject}`
  const hit = cache.get(key)
  if (hit) return hit
  const decision = await runClassify(ctx, cfg, c, info)
  cache.set(key, decision)
  return decision
}

/** 组装 classifier 请求：状态（只含判定所需数据）+ 单个 choice 问题 */
function buildContext(
  cwd: string,
  c: Contribution,
  info: ClassifyInfo
): {
  state: Record<string, string>
  questions: {
    verdict: { type: 'choice'; instructions: string; criteria: Record<string, string> }
  }
} {
  // state 只留对判定有用的三项：工具、工作目录，加上要判的东西
  // （face / value / rule / agent 对「该操作危不危险」没有信息量）
  const state: Record<string, string> = { tool: info.toolName, cwd }
  // bash 面给完整命令；其余面（path / external / mcp / 工具兜底）没有命令参数，
  // 给该面命中的对象，否则模型不知道在判什么
  if (info.command !== undefined) state['command'] = info.command
  else state['target'] = c.subject
  return {
    state,
    questions: {
      verdict: {
        type: 'choice',
        instructions: '该工具调用是否应该允许执行？',
        criteria: {
          allow: '能够确定该操作安全。',
          deny: '能够确定该操作危险。',
          unsure: '无法确定该操作安全或危险。'
        }
      }
    }
  }
}

/** 超时兜底：超时按 `ask` 处理（SPEC §6 超时中断） */
function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((res) => {
    const timer = setTimeout(() => res(undefined), timeoutMs)
    p.then(
      (v) => {
        clearTimeout(timer)
        res(v)
      },
      () => {
        clearTimeout(timer)
        res(undefined)
      }
    )
  })
}

/** 不带缓存的 classify 执行；任何异常/不确定都落 `ask` */
async function runClassify(
  ctx: ExtensionContext,
  cfg: ClassifierConfig | undefined,
  c: Contribution,
  info: ClassifyInfo
): Promise<Decision> {
  try {
    if (!cfg || typeof ctx.cwd !== 'string') return 'ask'
    const model = ctx.modelRegistry.findOfType('classifier', cfg.provider, cfg.model)
    if (!model) return 'ask'
    const request = buildContext(ctx.cwd, c, info)
    const timeoutMs = cfg.timeoutMs
    const result = await withTimeout(ctx.modelRegistry.classify(model, request), timeoutMs)
    if (!result || result.stopReason !== 'stop') return 'ask'
    const answer = result.answers['verdict']
    if (!answer || answer.type !== 'choice') return 'ask'
    // 概率 ≥ threshold 才采用（SPEC §6），否则 unsure → ask
    const prob = answer.probabilities?.[answer.choice] ?? 0
    if (prob < cfg.threshold) return 'ask'
    if (answer.choice === 'allow') return 'allow'
    if (answer.choice === 'deny') return 'deny'
    return 'ask'
  } catch {
    return 'ask' // 绝不因模型故障放行
  }
}
