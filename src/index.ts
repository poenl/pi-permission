import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

import { dirname } from 'node:path'

import { createAudit, type Audit } from './audit'
import { warmBashParser } from './bash-ast'
import { loadConfig, type ParsedConfig } from './config'
import type { ClassifyCache } from './classifier'
import { handleToolCall, hideDeniedTools } from './gate'

/**
 * pi-permission 扩展入口（SPEC §1/§4/§8/§9）。
 *
 * 会话级状态在 session_start 时建立：
 * - 配置加载（两层合并 + fail-closed），非法时通知用户
 * - classify 缓存与会话审批记忆（会话内有效）
 * - 被禁工具从活动工具列表移除（无 * 失配工具兜底）
 * tool_call 事件 → 门禁决策（deny 拦截 / ask 确认 / allow 放行）
 * /permission 命令提供运行时开关（reviewLog / debugLog / status）
 */
export default function piPermission(pi: ExtensionAPI): void {
  // 会话级状态：配置、classify 缓存、审批记忆、审计句柄（单例，用 getter 读活开关）
  let config: ParsedConfig | undefined
  let cache: ClassifyCache = new Map()
  const approveMemory = new Map<string, true>()
  let audit: Audit | undefined
  /** 内外判定基准：会话启动时的真实工作目录（不随子代理进程 cwd 漂移） */
  let sessionCwd = ''
  /** 已加载技能包根目录集合；其中文件读取直接忽略（不问不拦） */
  let skillRoots: string[] = []
  /** 总开关关闭前被隐藏的工具名单（重新启用/禁止时恢复可见用） */
  let lastHiddenTools: string[] = []
  /** pi-permission:set-enabled 监听的退订句柄（会话重启防重复注册） */
  let unsubscribeSetEnabled: (() => void) | undefined

  /**
   * 惰性初始化：每次都走 loadConfig——命中热缓存近乎零开销（两次 stat），
   * config.json 被改则即时重读（热重载，改配置无需 /reload）。
   * audit 单例：运行时开关经 getter 读取当前配置，热重载后仍即时生效。
   */
  const ensure = (ctx: ExtensionContext): { config: ParsedConfig; audit: Audit } => {
    const cfg = loadConfig(ctx.cwd)
    config = cfg
    // 审计单例用 getter 读当前配置的开关（热重载后仍即时生效）；ensure 先赋值 config，不会为空
    if (!audit) audit = createAudit(() => (config as ParsedConfig).runtime)
    return { config: cfg, audit }
  }

  /** 总开关同步：启用/开启 → 重跑隐藏判定；禁用 → 恢复被隐藏的工具（扩展无动作） */
  const syncHiddenTools = (piRef: ExtensionAPI, cfgRef: ParsedConfig): void => {
    if (cfgRef.runtime.enabled) {
      lastHiddenTools = hideDeniedTools(piRef, cfgRef)
    } else if (lastHiddenTools.length > 0) {
      const active = piRef.getActiveTools()
      const restore = [...active, ...lastHiddenTools.filter((n) => !active.includes(n))]
      piRef.setActiveTools(restore)
      lastHiddenTools = []
    }
  }

  pi.on('session_start', (_event, ctx) => {
    // 强制重解析（bypassCache）：每个会话的运行时开关从文件默认值重新开始，
    // 修复「开关跨会话泄漏」（共享缓存对象曾被上个会话的 /permission 改动污染）
    config = loadConfig(ctx.cwd, undefined, { bypassCache: true })
    // 内外判定基准：记录会话真实工作目录（回归：子代理进程 ctx.cwd 不同，
    // 用它判定会把项目文件错标成「工作目录外」）
    sessionCwd = ctx.cwd
    // skill 读取直接忽略（无配置项）：判定来源用 pi 自己已加载的 skill 清单，
    // 不穷举目录；取每个 SKILL.md 的所在目录为技能包根目录
    skillRoots = [
      ...new Set(
        pi
          .getCommands()
          .filter((c) => c.source === 'skill')
          .map((c) => c.sourceInfo.path)
          .map((p) => dirname(p))
      )
    ]
    // Other extensions' master-switch API：pi.events.emit('pi-permission:set-enabled', { enabled: true|false })
    // 无效载荷忽略；切换后同步工具可见性并 notify 提醒（留一次切换痕迹，之后无任何动作）
    unsubscribeSetEnabled?.()
    unsubscribeSetEnabled = pi.events.on('pi-permission:set-enabled', (data: unknown) => {
      const enabled = (data as { enabled?: unknown } | null | undefined)?.enabled
      if (typeof enabled !== 'boolean' || !config) return
      config.runtime.enabled = enabled
      syncHiddenTools(pi, config)
      ctx.ui.notify(`pi-permission：已${enabled ? '启用' : '禁用'}（事件 API）`, 'info')
      const { audit: log } = ensure(ctx as unknown as ExtensionContext)
      log.review({
        ts: new Date().toISOString(),
        event: 'runtime-toggle',
        key: 'enabled',
        value: enabled ? 'on' : 'off'
      })
    })
    cache = new Map()
    approveMemory.clear()
    // bash AST 解析器预热：session_start 早于任何 tool_call，预热后解析同步可用
    // （失败保持冷态，调用时降级为保守弹窗）
    void warmBashParser()
    if (config.invalid) {
      ctx.ui.notify(
        'pi-permission：配置非法，已 fail-closed（allow → ask，classifier 块停用）',
        'warning'
      )
    }
    // §8：启动前把被禁的工具从工具列表隐藏（总开关关闭时工具保持全可见）
    lastHiddenTools = config.runtime.enabled ? hideDeniedTools(pi, config) : []
  })

  // §4：工具调用门禁
  pi.on('tool_call', async (event, ctx) => {
    const { config: cfg, audit: log } = ensure(ctx)
    return handleToolCall(event, ctx, {
      config: cfg,
      cache,
      memory: approveMemory,
      audit: log,
      pi,
      // 基准目录兜底：session_start 未到时（异常序）用当前 ctx.cwd
      sessionCwd: sessionCwd || ctx.cwd,
      skillRoots
    })
  })

  // §9：MCP 工具出现在会话中途时重新执行隐藏判定（总开关关闭时保持全可见）
  pi.on('mcp_servers_change', () => {
    if (config?.runtime.enabled) lastHiddenTools = hideDeniedTools(pi, config)
  })

  // §9 运行时开关：/permission [status|enable|disable|review on|debug off …]
  pi.registerCommand('permission', {
    description: '查看/修改 pi-permission 运行时开关（启用/禁用、review、debug、status）',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { config: cfg, audit: log } = ensure(ctx as unknown as ExtensionContext)
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'status'
      const apply = (key: 'enabled' | 'permissionReviewLog' | 'debugLog', on?: boolean) => {
        if (on !== undefined) cfg.runtime[key] = on
        else cfg.runtime[key] = !cfg.runtime[key]
        const state = cfg.runtime[key] ? 'on' : 'off'
        ctx.ui.notify(`pi-permission：${key} = ${state}`, 'info')
        // audit 读取的是活引用，开关即时生效
        log.review({ ts: new Date().toISOString(), event: 'runtime-toggle', key, value: state })
        // 总开关变化需要同步工具可见性（恢复/重新隐藏）
        if (key === 'enabled') syncHiddenTools(pi, cfg)
      }
      switch (sub) {
        case 'status':
          ctx.ui.notify(
            `pi-permission 运行时开关\n` +
              `enabled=${cfg.runtime.enabled ? 'on' : 'off'} ` +
              `permissionReviewLog=${cfg.runtime.permissionReviewLog} ` +
              `debugLog=${cfg.runtime.debugLog}\n` +
              `用 /permission enable|disable | review on|off | debug on|off 切换`,
            'info'
          )
          break
        case 'enable':
          apply('enabled', true)
          break
        case 'disable':
          apply('enabled', false)
          break
        case 'review': {
          const on = parts[1] === undefined ? undefined : parts[1] === 'on' ? true : false
          apply('permissionReviewLog', on)
          break
        }
        case 'debug': {
          const on = parts[1] === undefined ? undefined : parts[1] === 'on' ? true : false
          apply('debugLog', on)
          break
        }
        default:
          ctx.ui.notify(
            '用法：/permission [status | enable | disable | review on|off | debug on|off]',
            'info'
          )
      }
    }
  })
}
