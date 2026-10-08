import { describe, expect, test } from 'vitest'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

import { classifyContribution } from '../src/classifier'
import type { ClassifierConfig } from '../src/config'
import type { Contribution } from '../src/engine'

/** 构造 classifier 结果对象 */
function result(choice: string, prob: number, stopReason = 'stop'): unknown {
  return {
    stopReason,
    answers: {
      verdict: { type: 'choice', choice, probabilities: { [choice]: prob }, confidence: prob }
    }
  }
}

/** 带 stub modelRegistry 的假 ExtensionContext */
function fakeCtx(opts: {
  model?: unknown
  classify?: (req: unknown) => unknown
}): ExtensionContext {
  return {
    cwd: '/w',
    hasUI: false,
    modelRegistry: {
      findOfType: () => opts.model,
      // 回调只关心 classify 的第二个参数（请求体），模型对象本身由测试忽略
      classify: async (_m: unknown, req: unknown) =>
        opts.classify ? opts.classify(req) : undefined
    }
  } as unknown as ExtensionContext
}

const entry: Contribution = { face: 'bash', subject: 'rm -rf x', value: 'classify' }
/** 附加上下文：真实工具名 + 完整命令 */
const info = { toolName: 'bash', command: 'rm -rf x' }
const cfg: ClassifierConfig = { provider: 'p', model: 'm', timeoutMs: 50, threshold: 0.5 }

describe('classifyContribution（§6）', () => {
  test('classifier 块缺失 → ask', async () => {
    const ctx = fakeCtx({ model: {}, classify: () => result('allow', 0.9) })
    expect(await classifyContribution(ctx, undefined, new Map(), entry, info)).toBe('ask')
  })
  test('模型取不到 → ask（§6 取不到即 ask）', async () => {
    const ctx = fakeCtx({ model: undefined, classify: () => result('allow', 0.9) })
    expect(await classifyContribution(ctx, cfg, new Map(), entry, info)).toBe('ask')
  })
  test('choice=allow 且概率 ≥ threshold → allow', async () => {
    let called = false
    const ctx = fakeCtx({
      model: { id: 'm' },
      classify: (_m) => {
        called = true
        return result('allow', 0.9)
      }
    })
    expect(await classifyContribution(ctx, cfg, new Map(), entry, info)).toBe('allow')
    expect(called).toBe(true)
  })
  test('概率低于阈值 → ask 未决', async () => {
    const ctx = fakeCtx({ model: {}, classify: () => result('allow', 0.3) })
    expect(await classifyContribution(ctx, cfg, new Map(), entry, info)).toBe('ask')
  })
  test('choice=deny → deny；choice=unsure → ask', async () => {
    const ctx = fakeCtx({ model: {}, classify: () => result('deny', 0.8) })
    expect(await classifyContribution(ctx, cfg, new Map(), entry, info)).toBe('deny')
    const ctx2 = fakeCtx({ model: {}, classify: () => result('unsure', 0.9) })
    expect(await classifyContribution(ctx2, cfg, new Map(), entry, info)).toBe('ask')
  })
  test('stopReason 非 stop / 无 answers → ask', async () => {
    const ctx = fakeCtx({ model: {}, classify: () => result('allow', 0.9, 'error') })
    expect(await classifyContribution(ctx, cfg, new Map(), entry, info)).toBe('ask')
    const ctx2 = fakeCtx({ model: {}, classify: () => undefined })
    expect(await classifyContribution(ctx2, cfg, new Map(), entry, info)).toBe('ask')
  })
  test('modelRegistry.classify reject → ask，绝不放行', async () => {
    const ctx = fakeCtx({
      model: {},
      classify: () => {
        throw new Error('auth failed')
      }
    })
    expect(await classifyContribution(ctx, cfg, new Map(), entry, info)).toBe('ask')
  })
  test('超时中断 → ask（timeoutMs 到期）', async () => {
    const ctx = fakeCtx({
      model: {},
      classify: () => new Promise(() => {}) // 永不完成
    })
    const started = Date.now()
    const out = await classifyContribution(ctx, { ...cfg, timeoutMs: 20 }, new Map(), entry, info)
    expect(out).toBe('ask')
    expect(Date.now() - started).toBeLessThan(2000)
  })
  test('会话内缓存：同 (面, 内容) 只调一次', async () => {
    let calls = 0
    const ctx = fakeCtx({
      model: {},
      classify: (_m) => {
        calls++
        return result('allow', 0.9)
      }
    })
    const cache = new Map()
    await classifyContribution(ctx, cfg, cache, entry, info)
    await classifyContribution(ctx, cfg, cache, entry, info)
    expect(calls).toBe(1)
  })
  test('非 bash 面：请求 state 带判定对象 target、无 command', async () => {
    const captured: unknown[] = []
    const ctx = fakeCtx({
      model: {},
      classify: (req) => {
        captured.push(req)
        return result('allow', 0.9)
      }
    })
    const pathEntry: Contribution = { face: 'path', subject: '/w/a.txt', value: 'classify' }
    expect(await classifyContribution(ctx, cfg, new Map(), pathEntry, { toolName: 'read' })).toBe(
      'allow'
    )
    const req = captured[0] as { state: Record<string, string> }
    expect(req.state.target).toBe('/w/a.txt')
    expect(req.state.command).toBeUndefined()
  })
  test('提示词带上真实工具名与完整命令', async () => {
    let captured:
      | { state: Record<string, string>; questions: { verdict: { instructions: string } } }
      | undefined
    const ctx = fakeCtx({
      model: {},
      classify: (m) => {
        captured = m as never
        return result('allow', 0.9)
      }
    })
    // shellTools 别名场景：真实工具名与面名不同
    const hit: Contribution = {
      face: 'bash',
      subject: 'status',
      value: 'classify',
      pattern: 'git *'
    }
    await classifyContribution(ctx, cfg, new Map(), hit, { toolName: 'git', command: 'git status' })
    expect(captured?.state.tool).toBe('git')
    expect(captured?.state.command).toBe('git status')
  })
})
