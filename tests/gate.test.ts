import { describe, expect, test } from 'vitest'

import type { Contribution, Decision } from '../src/engine'
import {
  collectPathsAndCommand,
  handleToolCall,
  resolveDecision,
  splitMcpName,
  toolFallback,
  hideDeniedTools
} from '../src/gate'
import type { ParsedConfig } from '../src/config'

/** 最小可用配置 */
function baseConfig(overrides: Partial<ParsedConfig> = {}): ParsedConfig {
  return {
    toolRules: [],
    pathRules: [],
    bashRules: [],
    externalRules: [],
    mcpRules: [],
    shellTools: [],
    runtime: {
      enabled: true,
      debugLog: false,
      permissionReviewLog: false
    },
    invalid: false,
    ...overrides
  }
}

describe('工具名兜底面（§2）', () => {
  test('精确名 → 后匹配者胜；无命中 → 默认 ask', () => {
    const rules: [string, string][] = [
      ['*', 'allow'],
      ['read', 'ask']
    ]
    expect(toolFallback(rules as never, 'read')).toBe('ask')
    expect(toolFallback(rules as never, 'write')).toBe('allow')
    expect(toolFallback([], 'anything')).toBe('ask')
  })
  test('支持通配工具名（如 mcp__*）', () => {
    const rules: [string, string][] = [['mcp__*', 'ask']]
    expect(toolFallback(rules as never, 'mcp__docs_search')).toBe('ask')
  })
})

describe('决策合成（§4）', () => {
  const c = (face: string, subject: string, value: string): Contribution =>
    ({ face, subject, value }) as Contribution
  const classify = async (x: Contribution): Promise<Decision> =>
    // 只对真实命令片段（以 rm 开头）判 deny；避免误匹配 "permission" 中的 rm 子串
    x.subject.startsWith('rm') ? 'deny' : 'allow'

  test('有 deny/ask 直接定案，不调 classifier', async () => {
    let calls = 0
    const spy = async (_x: Contribution): Promise<Decision> => {
      calls++
      return 'allow'
    }
    expect(
      await resolveDecision([c('path', '/a.env', 'deny'), c('bash', 'ls', 'ask')], 'allow', spy)
    ).toBe('deny')
    expect(await resolveDecision([c('bash', 'ls', 'ask')], 'allow', spy)).toBe('ask')
    expect(calls).toBe(0)
  })
  test('classify 解析后重新合成（allow / deny / 未决 ask）', async () => {
    expect(
      await resolveDecision(
        [c('path', '/tmp/x', 'classify'), c('tool', 'read', 'allow')],
        'ask',
        classify
      )
    ).toBe('allow')
    expect(await resolveDecision([c('bash', 'rm -rf x', 'classify')], 'allow', classify)).toBe(
      'deny'
    )
  })
  test('四面全未命中 → 工具兜底面；兜底为 classify 也解析', async () => {
    expect(await resolveDecision([], 'ask', classify)).toBe('ask')
    expect(await resolveDecision([], 'classify', classify)).toBe('allow')
  })
  test('unresolved ask（分类器兜底）→ ask', async () => {
    expect(
      await resolveDecision([c('bash', 'whatever', 'classify')], 'allow', async () => 'ask')
    ).toBe('ask')
  })
})

describe('路径与命令收集（§5）', () => {
  test('内建文件工具取 path，缺省为 cwd', () => {
    const cfg = baseConfig()
    expect(collectPathsAndCommand('read', { path: '/a/b' }, '/w', cfg)).toEqual({ paths: ['/a/b'] })
    expect(collectPathsAndCommand('grep', { pattern: 'x' }, '/w', cfg)).toEqual({ paths: ['/w'] })
  })
  test('bash 工具解析命令 并提取路径 token', () => {
    const cfg = baseConfig()
    const r = collectPathsAndCommand('bash', { command: 'cat /a/.env' }, '/w', cfg)
    expect(r.command).toBe('cat /a/.env')
  })
  test('§9 shellTools 命名工具走 bash 规则', () => {
    const cfg = baseConfig({ shellTools: ['git'] })
    expect(collectPathsAndCommand('git', { command: 'status' }, '/w', cfg).command).toBe('status')
    expect(collectPathsAndCommand('git', {}, '/w', cfg).command).toBeUndefined()
  })
  test('自定义工具字符串输入保守扫描', () => {
    const cfg = baseConfig()
    const r = collectPathsAndCommand(
      'custom',
      { url: 'https://x/y', target: '/etc/passwd', n: 1 },
      '/w',
      cfg
    )
    expect(r.paths).toContain('/etc/passwd')
    expect(r.paths).not.toContain('https://x/y') // URL 排除，不误报
  })
  test('codemode 的 code 源码不被当成路径', () => {
    const cfg = baseConfig()
    const code = '// 注释\nconst hit = ALL_TOOLS.filter((t) => /x/i.test(t.name))'
    const r = collectPathsAndCommand('codemode', { code }, '/w', cfg)
    expect(r.paths).toEqual([])
    expect(r.command).toBeUndefined()
  })
})

describe('MCP 工具名解析', () => {
  test('mcp__server__tool', () => {
    expect(splitMcpName('mcp__github__pr_create')).toEqual({ server: 'github', tool: 'pr_create' })
    expect(splitMcpName('read')).toBeUndefined()
    expect(splitMcpName('mcp__weird')).toBeUndefined()
  })
})

describe('被禁工具隐藏（§8）', () => {
  test('工具兜底面 = deny 的工具被移出活动列表', () => {
    const cfg = baseConfig({
      toolRules: [
        ['write', 'deny'],
        ['mcp__bad*', 'deny']
      ] as never
    })
    const active: string[] = ['read', 'write', 'mcp__bad_tool']
    const setCalls: string[][] = []
    const pi = {
      getAllTools: () => active.map((name) => ({ name })),
      getActiveTools: () => [...active],
      setActiveTools: (t: string[]) => {
        setCalls.push(t)
      }
    } as never
    const removed = hideDeniedTools(pi, cfg)
    expect(setCalls[0]).toEqual(['read'])
    expect(removed).toEqual(['write', 'mcp__bad_tool'])
  })
})

describe('未展开变量保守弹窗', () => {
  const auditStub = { review: () => {}, debug: () => {} }
  function makeState(bashRules: [string, string][] | never[] = []) {
    return {
      config: baseConfig({ bashRules: bashRules as never }),
      cache: new Map(),
      memory: new Map(),
      audit: auditStub,
      pi: { getAllTools: () => [], events: { emit: () => {} } } as never,
      sessionCwd: '/proj',
      skillRoots: []
    }
  }
  const ev = (toolName: string, input: Record<string, unknown>): never =>
    ({ type: 'tool_call', toolCallId: 't1', toolName, input }) as never

  test('含变量的段即使规则 allow 也强制 ask（保守，宁可多问）', async () => {
    const state = makeState([['cat *', 'allow']])
    const ctx = { cwd: '/proj', hasUI: false, mode: 'rpc' } as never
    // decision=ask 且无 UI → fail-closed 拦截；若被判 allow 则返回 undefined
    const r = await handleToolCall(ev('bash', { command: 'cat $HOME/x' }), ctx, state as never)
    expect(r?.block).toBe(true)
  })

  test('普通段不受保守弹窗影响：规则 allow 直接放行', async () => {
    const state = makeState([['cat *', 'allow']])
    const ctx = { cwd: '/proj', hasUI: false, mode: 'rpc' } as never
    const r = await handleToolCall(ev('bash', { command: 'cat /tmp/x' }), ctx, state as never)
    expect(r).toBeUndefined()
  })
})

describe('会话审批记忆：键含工具名（回归：跨工具放大）', () => {
  const auditStub = { review: () => {}, debug: () => {} }

  /** 空规则配置 → 有输入的工具都落工具兜底面 ask，便于验证记忆隔离 */
  function makeState() {
    return {
      config: baseConfig(),
      cache: new Map(),
      memory: new Map(),
      audit: auditStub,
      pi: { getAllTools: () => [], events: { emit: () => {} } } as never,
      sessionCwd: '/proj',
      skillRoots: []
    }
  }
  /** 指定用户弹窗选择的 UI 上下文（TUI 模式，ui.custom 直接返回选择） */
  const uiCtx = (choice: 'allow' | 'session' | 'deny') =>
    ({ cwd: '/proj', hasUI: true, mode: 'tui', ui: { custom: async () => choice } }) as never
  const ev = (toolName: string, input: Record<string, unknown> = {}): never =>
    ({ type: 'tool_call', toolCallId: 't1', toolName, input }) as never

  test('read 选「本会话都允许」后同工具不再弹窗；edit 同输入仍弹窗', async () => {
    const state = makeState() as never
    const r1 = await handleToolCall(ev('read', { path: '/tmp/x' }), uiCtx('session'), state)
    expect(r1).toBeUndefined() // 弹窗 → 选本会话都允许 → 放行

    // 同工具再调用：记忆键含工具名 → 命中 → 不弹窗直接放行（弹窗被调即抛错）
    const noDialog = {
      cwd: '/proj',
      hasUI: true,
      mode: 'tui',
      ui: {
        custom: async () => {
          throw new Error('不应弹窗')
        }
      }
    } as never
    const r2 = await handleToolCall(ev('read', { path: '/tmp/x' }), noDialog, state)
    expect(r2).toBeUndefined()

    // 另一工具同输入：记忆键含工具名 → 不命中 → 照旧弹窗（拒绝 → 拦截）
    const r3 = await handleToolCall(ev('edit', { path: '/tmp/x' }), uiCtx('deny'), state)
    expect(r3?.block).toBe(true)
  })
})

describe('会话审批记忆：目录覆盖（回归：父目录允许后子目录还询问）', () => {
  const auditStub = { review: () => {}, debug: () => {} }

  /** path 面 `*`=ask：让命中落在 path 面（而非工具兜底面），便于验证目录覆盖 */
  function makeState() {
    return {
      config: baseConfig({ pathRules: [['*', 'ask']] }),
      cache: new Map(),
      memory: new Map(),
      audit: auditStub,
      pi: { getAllTools: () => [], events: { emit: () => {} } } as never,
      sessionCwd: '/proj',
      skillRoots: []
    }
  }
  const uiCtx = (choice: 'allow' | 'session' | 'deny') =>
    ({ cwd: '/proj', hasUI: true, mode: 'tui', ui: { custom: async () => choice } }) as never
  /** 弹窗被调用即视为失败：目录已覆盖时不应再问 */
  const noDialog = {
    cwd: '/proj',
    hasUI: true,
    mode: 'tui',
    ui: {
      custom: async () => {
        throw new Error('不应弹窗')
      }
    }
  } as never
  const ev = (path: string): never =>
    ({ type: 'tool_call', toolCallId: 't1', toolName: 'read', input: { path } }) as never

  test('允许文件夹后，里面的子目录与文件不再询问；文件夹外仍询问', async () => {
    const state = makeState() as never
    expect(await handleToolCall(ev('/ext'), uiCtx('session'), state)).toBeUndefined()
    // 深层文件：命中已允许的目录 → 不弹窗直接放行
    expect(await handleToolCall(ev('/ext/sub/a.txt'), noDialog, state)).toBeUndefined()
    // 文件夹外：照旧弹窗（拒绝 → 拦截）
    expect((await handleToolCall(ev('/other/b.txt'), uiCtx('deny'), state))?.block).toBe(true)
  })

  test('允许一个文件后，它所在目录里的其他文件不再询问（读文件的情况）', async () => {
    const state = makeState() as never
    expect(await handleToolCall(ev('/ext/a.txt'), uiCtx('session'), state)).toBeUndefined()
    expect(await handleToolCall(ev('/ext/b.txt'), noDialog, state)).toBeUndefined()
    expect((await handleToolCall(ev('/other/c.txt'), uiCtx('deny'), state))?.block).toBe(true)
  })
})

describe('skill 读取忽略 + 外部判定基准（回归）', () => {
  const auditStub = { review: () => {}, debug: () => {} }

  /** 构造带基准目录与技能包根目录的门禁状态 */
  function makeState(config: ParsedConfig, sessionCwd: string, skillRoots: string[] = []) {
    return {
      config,
      cache: new Map(),
      memory: new Map(),
      audit: auditStub,
      pi: { getAllTools: () => [], events: { emit: () => {} } } as never,
      sessionCwd,
      skillRoots
    }
  }
  const ev = (toolName: string, input: Record<string, unknown>): never =>
    ({ type: 'tool_call', toolCallId: 't1', toolName, input }) as never

  test('读取已加载技能包内文件 → 直接忽略放行（无 UI 也放行，不问不拦）', async () => {
    const state = makeState(baseConfig(), '/proj', ['/tmp/roots/skx'])
    const ctx = { cwd: '/elsewhere', hasUI: false, mode: 'tui' } as never
    const r = await handleToolCall(
      ev('read', { path: '/tmp/roots/skx/SKILL.md' }),
      ctx,
      state as never
    )
    expect(r).toBeUndefined()
  })
  test('项目外读取仍受控：按会话基准 cwd 判外部，无 UI → 拦截且理由含工作目录外', async () => {
    const cfg = baseConfig({ externalRules: [['*', 'ask']] as never })
    const state = makeState(cfg, '/proj/sub')
    const ctx = { cwd: '/elsewhere', hasUI: false, mode: 'tui' } as never
    const r = await handleToolCall(ev('read', { path: '/proj/other/x.md' }), ctx, state as never)
    expect(r?.block).toBe(true)
    expect(r?.reason).toContain('工作目录外')
  })
})

describe('总开关与事件（ 第二十批）', () => {
  /** 记录型审计 stub */
  function recordingAudit() {
    const calls: unknown[] = []
    return { calls, audit: { review: (r: unknown) => calls.push(r), debug: () => {} } }
  }
  /** 事件总线记录 stub */
  function recordingEvents() {
    const log: [string, unknown][] = []
    return {
      log,
      pi: {
        getAllTools: () => [],
        events: { emit: (ch: string, data: unknown) => log.push([ch, data]) }
      }
    }
  }
  /** 拼一个完整的门禁状态；enabled=false 注入 runtime，config 传 Partial<ParsedConfig> */
  function state(
    overrides: {
      config?: Partial<ParsedConfig>
      enabled?: boolean
      memory?: Map<string, true>
      skillRoots?: string[]
    } = {}
  ) {
    const a = recordingAudit()
    const e = recordingEvents()
    const cfg = baseConfig(overrides.config ?? {})
    if (overrides.enabled === false) cfg.runtime.enabled = false
    return {
      ...a,
      ...e,
      get auditLogs() {
        return a.calls
      },
      st: {
        config: cfg,
        cache: new Map(),
        memory: overrides.memory ?? new Map(),
        audit: a.audit,
        pi: e.pi,
        sessionCwd: '/proj',
        skillRoots: overrides.skillRoots ?? []
      } as never,
      ev: (toolName: string, input: Record<string, unknown>): never =>
        ({ type: 'tool_call', toolCallId: 't1', toolName, input }) as never,
      ctx: { cwd: '/proj', hasUI: false, mode: 'rpc' } as never
    }
  }
  const resolved = (log: [string, unknown][]) =>
    log.filter(([ch]) => ch === 'pi-permission:resolved') as [string, Record<string, unknown>][]

  test('总开关关闭：deny 规则也不拦截，无审计无事件', async () => {
    const h = state({ config: { bashRules: [['rm -rf *', 'deny']] as never }, enabled: false })
    const r = await handleToolCall(h.ev('bash', { command: 'rm -rf /proj/x' }), h.ctx, h.st)
    expect(r).toBeUndefined()
    expect(h.log.length).toBe(0)
    expect(h.auditLogs.length).toBe(0)
  })

  test('配置 allow → 发 resolved allow；配置 deny → 发 resolved deny 且拦截', async () => {
    const a = state({ config: { bashRules: [['cat *', 'allow']] } as never })
    await handleToolCall(a.ev('bash', { command: 'cat /tmp/x' }), a.ctx, a.st)
    expect(resolved(a.log)).toEqual([
      [
        'pi-permission:resolved',
        {
          type: 'allow',
          tool: 'bash',
          command: 'cat /tmp/x',
          paths: ['/tmp/x'],
          ts: resolved(a.log)[0]?.[1]?.ts as string
        }
      ]
    ])
    const d = state({ config: { bashRules: [['rm -rf *', 'deny']] } as never })
    const r = await handleToolCall(d.ev('bash', { command: 'rm -rf /proj/x' }), d.ctx, d.st)
    expect(r?.block).toBe(true)
    expect(resolved(d.log).map(([, p]) => p.type)).toEqual(['deny'])
  })

  test('ask 弹窗：出现发 ask 事件；选择结束按 allow/deny 发 resolved', async () => {
    // 弹窗路径需要 UI：hasUI=true 且 mode=tui（ui.custom 直接返回选择）
    const a = state({})
    ;(a.st as { pi: unknown }).pi = {
      getAllTools: () => [],
      events: {
        emit: (ch: string, data: unknown) => a.log.push([ch, data])
      }
    }
    const askCtx = {
      cwd: '/proj',
      hasUI: true,
      mode: 'tui',
      ui: { custom: async () => 'allow' }
    } as never
    const r1 = await handleToolCall(a.ev('bash', { command: 'ls /tmp/x' }), askCtx, a.st)
    expect(r1).toBeUndefined()
    const channels = a.log.map(([ch]) => ch)
    expect(channels).toContain('pi-permission:ask')
    expect(resolved(a.log).map(([, p]) => p.type)).toEqual(['allow'])
    // 拒绝
    const d = state({})
    ;(d.st as { pi: unknown }).pi = {
      getAllTools: () => [],
      events: { emit: (ch: string, data: unknown) => d.log.push([ch, data]) }
    }
    const denyCtx = {
      cwd: '/proj',
      hasUI: true,
      mode: 'tui',
      ui: { custom: async () => 'deny' }
    } as never
    const r2 = await handleToolCall(d.ev('bash', { command: 'ls /tmp/x' }), denyCtx, d.st)
    expect(r2?.block).toBe(true)
    expect(resolved(d.log).map(([, p]) => p.type)).toEqual(['deny'])
  })

  test('记忆放行（无 UI）→ 发 resolved allow；无 UI 拦截 → 发 resolved deny；skill 忽略 → 无事件', async () => {
    const a = state({
      config: { pathRules: [['*', 'ask']] as never },
      memory: new Map([['read\u0000path\u0000/tmp/x', true as const]])
    })
    const r1 = await handleToolCall(a.ev('read', { path: '/tmp/x' }), a.ctx, a.st)
    expect(r1).toBeUndefined()
    expect(resolved(a.log).map(([, p]) => p.type)).toEqual(['allow'])
    // 无 UI 拦截（path 规则 ask，无记忆命中 → 无 UI fail-closed）
    const d = state({ config: { pathRules: [['*', 'ask']] as never } })
    const r2 = await handleToolCall(d.ev('read', { path: '/tmp/x' }), d.ctx, d.st)
    expect(r2?.block).toBe(true)
    expect(resolved(d.log).map(([, p]) => p.type)).toEqual(['deny'])
    // skill 忽略：无事件
    const sk = state({ skillRoots: ['/tmp/roots/skx'] })
    const r3 = await handleToolCall(
      sk.ev('read', { path: '/tmp/roots/skx/SKILL.md' }),
      sk.ctx,
      sk.st
    )
    expect(r3).toBeUndefined()
    expect(sk.log.length).toBe(0)
  })
})

describe('classify 提示词带上判断依据（第二十一批）', () => {
  test('bash 面经 shellTools 别名：传给模型的是真实工具名、命中规则与完整命令', async () => {
    // shellTools 别名走 bash 面：真实工具名是 git，不能把面名 bash 当工具名传
    const cfg = baseConfig({ shellTools: ['git'], bashRules: [['git *', 'classify']] })
    cfg.classifier = { provider: 'p', model: 'm', timeoutMs: 50, threshold: 0.5 }
    const captured: unknown[] = []
    const ctx = {
      cwd: '/proj',
      hasUI: false,
      mode: 'rpc',
      modelRegistry: {
        findOfType: () => ({ id: 'm' }),
        classify: async (_m: unknown, req: unknown) => {
          captured.push(req)
          return {
            stopReason: 'stop',
            answers: { verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.9 } } }
          }
        }
      }
    } as never
    const st = {
      config: cfg,
      cache: new Map(),
      memory: new Map(),
      audit: { review: () => {}, debug: () => {} },
      pi: { getAllTools: () => [], events: { emit: () => {} } },
      sessionCwd: '/proj',
      skillRoots: []
    } as never
    const ev = {
      type: 'tool_call',
      toolCallId: 't1',
      toolName: 'git',
      input: { command: 'git status' }
    } as never
    const r = await handleToolCall(ev, ctx, st)
    expect(r).toBeUndefined()
    const req = captured[0] as {
      state: Record<string, string>
      questions: { verdict: { criteria: Record<string, string> } }
    }
    expect(req.state.tool).toBe('git')
    expect(req.state.command).toBe('git status')
    // 判据三选项随请求发给模型
    expect(Object.keys(req.questions.verdict.criteria)).toEqual(['allow', 'deny', 'unsure'])
  })
  test('path 面命中 classify：会调模型，并把判定对象当作 target 传给模型', async () => {
    const cfg = baseConfig({ pathRules: [['*', 'classify']] })
    cfg.classifier = { provider: 'p', model: 'm', timeoutMs: 50, threshold: 0.5 }
    const captured: unknown[] = []
    const ctx = {
      cwd: '/proj',
      hasUI: false,
      mode: 'rpc',
      modelRegistry: {
        findOfType: () => ({ id: 'm' }),
        classify: async (_m: unknown, req: unknown) => {
          captured.push(req)
          return {
            stopReason: 'stop',
            answers: { verdict: { type: 'choice', choice: 'deny', probabilities: { deny: 0.9 } } }
          }
        }
      }
    } as never
    const st = {
      config: cfg,
      cache: new Map(),
      memory: new Map(),
      audit: { review: () => {}, debug: () => {} },
      pi: { getAllTools: () => [], events: { emit: () => {} } },
      sessionCwd: '/proj',
      skillRoots: []
    } as never
    const ev = {
      type: 'tool_call',
      toolCallId: 't1',
      toolName: 'read',
      input: { path: '/proj/a.txt' }
    } as never
    // 模型判 deny → 拦截
    expect((await handleToolCall(ev, ctx, st))?.block).toBe(true)
    const req = captured[0] as { state: Record<string, string> }
    expect(req.state.tool).toBe('read')
    expect(req.state.target).toBe('/proj/a.txt')
    expect(req.state.command).toBeUndefined()
  })
})
