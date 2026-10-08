import { dirname } from 'node:path'

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult
} from '@earendil-works/pi-coding-agent'

import type { ParsedConfig } from './config'
import { parseCommand, type ParsedCommand } from './bash-ast'
import { classifyContribution, type ClassifyCache } from './classifier'
import {
  globMatch,
  isInside,
  matchBashPattern,
  matchFace,
  normalizePath,
  pathForms,
  strictest,
  type Contribution,
  type Decision,
  type FaceKey,
  type FaceValue,
  type Rule
} from './engine'
import type { Audit } from './audit'
import { AskDialogComponent, ASK_OPTIONS, type AskChoice, type AskPayload } from './dialog'

/**
 * tool_call 门禁（SPEC §4 决策流程 + §8 执行上下文）。
 *
 * 流程：收集文件路径与命令 → 四面命中（path / bash /
 * external / mcp）→ 无命中时回落到工具名兜底面 → classify 解析（仅当
 * 最严者为 classify）→ 严格执行度合成 → deny 拦 / ask 弹确认（无 UI
 * 拦截，fail-closed）/ allow 放行。会话审批记忆在 ask 生效前检查。
 */

/** FaceKey 的中文名（用于审计与拒绝理由） */
const FACE_LABEL: Record<FaceKey, string> = {
  tool: '工具策略',
  path: '文件路径',
  bash: '命令',
  external: '工作目录外',
  mcp: 'MCP 工具'
}

/** 门禁的会话级状态 */
export interface GateState {
  config: ParsedConfig
  /** classify 结果缓存（面 + 内容，会话内） */
  cache: ClassifyCache
  /** 会话审批记忆：用户选「本会话都允许」的 (面, 内容) 键 */
  memory: Map<string, true>
  audit: Audit
  pi: ExtensionAPI
  /**
   * 内外路径判定的基准工作目录：session_start 时记录的会话真实目录。
   * 回归修复：子代理进程的 ctx.cwd 不是项目目录，用它判定会把项目文件错标成
   * 「工作目录外」并反复弹窗；现在统一用会话真实目录。
   */
  sessionCwd: string
  /** 已加载技能包根目录集合（session_start 时从 pi.getCommands() 的 source==='skill' 取得）；
   * 内部文件的读取直接忽略（不问不拦，不加配置项） */
  skillRoots: string[]
}

/** 过滤「skill 读取」：路径（任一形态）位于任一已加载技能包内 → 忽略 */
function filterSkillPaths(paths: string[], cwd: string, skillRoots: string[]): string[] {
  if (skillRoots.length === 0) return paths
  return paths.filter((p) => {
    const forms = pathForms(cwd, p)
    return !skillRoots.some((root) => forms.some((f) => isInside(root, f)))
  })
}

/** 从字符串输入里找出近似路径候选（自定义工具输入的保守扫描；URL 排除） */
function stringLikePath(v: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v)) return false
  return v.includes('/') || v.startsWith('~')
}

/** 收集一次调用涉及的全部路径候选（写出形式）与命令文本 */
export function collectPathsAndCommand(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  cfg: ParsedConfig
): { paths: string[]; command?: string } {
  const paths: string[] = []
  // 内建文件类工具：直接取 path 字段（缺省视为 cwd，如 ls/grep/find）
  if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
    if (typeof input.path === 'string') paths.push(input.path)
    return { paths }
  }
  if (toolName === 'ls' || toolName === 'grep' || toolName === 'find') {
    paths.push(typeof input.path === 'string' ? input.path : cwd)
    return { paths }
  }
  // bash / powershell / §9 shellTools：解析命令文本（bash 面 + 路径 token）
  if (toolName === 'bash' || toolName === 'powershell' || cfg.shellTools.includes(toolName)) {
    const command = typeof input.command === 'string' ? input.command : undefined
    return { paths, command }
  }
  // codemode：入参 code 是 JS 源码而非路径，不参与字符串扫描（其脚本里的
  // tools.bash / tools.read 等真实调用会由 pi 作为嵌套调用再次经过本门禁，
  // 所以排除扫描不会漏掉任何真实操作；见 pi docs/extensions.md 嵌套调用）
  if (toolName === 'codemode') return { paths }
  // 自定义 / MCP 工具：对字符串输入做保守扫描（出现 '/' 或 '~' 即视为路径候选）
  for (const v of Object.values(input)) {
    if (typeof v === 'string') {
      if (stringLikePath(v)) paths.push(v)
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && stringLikePath(item)) paths.push(item)
      }
    }
  }
  return { paths }
}

/** MCP 工具名 → server / tool（`mcp__<server>__<tool>`，连字符已被下划线替换） */
export function splitMcpName(toolName: string): { server: string; tool: string } | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const rest = toolName.slice(5)
  const idx = rest.indexOf('__')
  if (idx <= 0) return undefined
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) }
}

/** 连字符与下划线等价归一（MCP 命名将 - 替换为 _） */
const canon = (s: string): string => s.replace(/-/g, '_')

/** MCP 面匹配：'*' / '<server>' / '<server>/<tool>'；带 '*' 的键走通配 */
function mcpMatcher(server: string, tool: string): (pattern: string) => boolean {
  const full = `${server}/${tool}`
  const fullCanon = `${canon(server)}/${canon(tool)}`
  const munged = `mcp__${canon(server)}__${canon(tool)}`
  return (pattern) => {
    if (pattern === '*' || pattern === server || pattern === full) return true
    if (pattern.includes('*') && (globMatch(pattern, fullCanon) || globMatch(pattern, munged)))
      return true
    if (canon(pattern) === fullCanon || canon(pattern) === canon(server)) return true
    return false
  }
}

/** 工具名兜底面取值：按声明顺序「后匹配者胜」，无规则 → 缺省 ask（SPEC §3） */
export function toolFallback(rules: Rule[], toolName: string): FaceValue {
  let value: FaceValue = 'ask'
  for (const [pattern, v] of rules) {
    if (globMatch(pattern, toolName)) value = v
  }
  return value
}

/**
 * 决策合成（SPEC §4）：
 * - 四面各有命中 → 取最严；全无命中 → 工具名兜底面
 * - 最严者为 deny / ask → 直接定案（不调 classifier）
 * - 最严者为 classify → 逐条解析（带缓存）后重新合成
 */
export async function resolveDecision(
  contributions: Contribution[],
  fallback: FaceValue,
  classify: (c: Contribution) => Promise<Decision>
): Promise<Decision> {
  const list: Contribution[] = contributions.length
    ? contributions
    : [{ face: 'tool', subject: toolFallbackFaceSubject(fallback), value: fallback }]
  const raw = strictest(list.map((e) => e.value))
  if (raw === 'deny' || raw === 'ask') return raw as Decision
  const need = list.filter((e) => e.value === 'classify')
  if (need.length === 0) return 'allow'
  for (const e of need) {
    e.value = await classify(e)
  }
  return strictest(list.map((e) => e.value)) as Decision
}

/** 兜底面命的 subject 文案 */
function toolFallbackFaceSubject(value: FaceValue): string {
  return `permission["*"] / 工具兜底 → ${value}`
}

/** 无 UI 时的拒绝理由（SPEC §4.5：无 UI 拦截 = fail-closed） */
function noUiReason(entries: Contribution[]): string {
  const detail = entries.map((e) => `${FACE_LABEL[e.face]}=${e.subject}`).join('，')
  return `需要人工确认但当前无可用 UI（子代理/非交互模式），按 fail-closed 拦截（${detail}）。可在 permission 配置中允许该操作，或改用交互会话执行。`
}

/** 拒绝理由（deny / 人工拒绝共用） */
function denyReason(entries: Contribution[], manual: boolean): string {
  const detail = entries.map((e) => `${FACE_LABEL[e.face]}=${e.subject}`).join('，')
  return manual ? `用户拒绝了该操作（${detail}）` : `permission 配置拒绝了该操作（${detail}）`
}

/** 会话审批记忆键：工具名 + 匹配面 + 主语；工具名参与，避免跨工具放大
 *（修复：工具 A 的兜底允许会自动放行任何其他兜底工具；read 允许 ≠ edit 放行） */
function memKey(toolName: string, face: FaceKey, subject: string): string {
  return `${toolName}\u0000${face}\u0000${subject}`
}

/** 一条命中对应的记忆键 */
function memoryKey(toolName: string, e: Contribution): string {
  return memKey(toolName, e.face, e.subject)
}

/** 会话审批记忆命中 → 视为放行（SPEC §8：本会话全部允许） */
function memoryAllows(
  toolName: string,
  entries: Contribution[],
  memory: Map<string, true>
): boolean {
  return entries.some((e) => e.value === 'ask' && memoryHits(toolName, e, memory))
}

/**
 * 记忆命中判定：地址完全相同，或（path / external 面）本次地址在已记的目录里面。
 * 回归修复：以前只认完全相同的地址，所以会话允许过一个文件夹后，它下面的子目录与
 * 文件仍是新地址 → 每次都重新询问。bash 段 / mcp / 工具兜底面仍按完全相同判定。
 */
function memoryHits(toolName: string, e: Contribution, memory: Map<string, true>): boolean {
  if (memory.has(memoryKey(toolName, e))) return true
  if (e.face !== 'path' && e.face !== 'external') return false
  // 已记路径若等于或包含本次地址，视为命中（isInside 同时覆盖相等的情形）
  const prefix = memKey(toolName, e.face, '')
  for (const key of memory.keys()) {
    if (!key.startsWith(prefix)) continue
    if (isInside(key.slice(prefix.length), e.subject)) return true
  }
  return false
}

/**
 * 记录会话审批记忆（用户选「本会话都允许」）：路径面除自身外再记住所在目录，
 * 让「允许一个文件或文件夹」覆盖它所在的目录（SPEC §8：会话内不再重复询问）。
 */
function rememberAllow(toolName: string, entries: Contribution[], memory: Map<string, true>): void {
  for (const e of entries) {
    if (e.value !== 'ask') continue
    memory.set(memoryKey(toolName, e), true)
    if (e.face !== 'path' && e.face !== 'external') continue
    const dir = dirname(e.subject)
    // 不记根目录（dir 已是根时 dirname(dir) === dir）：否则等于放行整个文件系统
    if (dirname(dir) === dir) continue
    memory.set(memKey(toolName, e.face, dir), true)
  }
}

/**
 * ask 弹窗：TUI 模式 → 无边框自定义组件（提示要执行的命令，见 dialog.ts），
 * 以非 overlay 模式替换 editor 区显示（与官方 qna.ts 范例同路径，可见性由
 * pi 内置流程保证；确认后自动还原输入框。不用 overlay: true——其布局兜底
 * 依赖组件 width 属性，曾出现弹窗不可见问题）；其它有 UI 模式（RPC 转发
 * 协议）→ 默认 ui.select，平台限制保留边框；无 UI 场景由调用方先行拦截。
 * 选择失败/关闭（undefined）一律按拒绝处理。
 */
async function askUser(
  ctx: ExtensionContext,
  payload: AskPayload
): Promise<'allow' | 'session' | 'deny'> {
  if (ctx.mode === 'tui') {
    const choice = await ctx.ui.custom<AskChoice | undefined>(
      (_tui, theme, _kb, done) =>
        new AskDialogComponent(
          payload,
          // theme.fg/bold 的 ThemeColor 形参较窄，包一层适配宽松签名
          { fg: (color, text) => theme.fg(color as never, text), bold: (t) => theme.bold(t) },
          (c) => done(c),
          () => done(undefined)
        )
    )
    return choice ?? 'deny'
  }
  const pick = await ctx.ui.select(payload.title, [...ASK_OPTIONS])
  if (pick === ASK_OPTIONS[0]) return 'allow'
  if (pick === ASK_OPTIONS[1]) return 'session'
  return 'deny'
}

/** ask/resolved 事件共用载荷（command/paths 缺省不列） */
function eventBase(toolName: string, command: string | undefined, paths: string[], ts: string) {
  return {
    tool: toolName,
    ...(command !== undefined ? { command } : {}),
    ...(paths.length > 0 ? { paths: [...paths] } : {}),
    ts
  }
}

/**
 * tool_call 入口：返回 undefined 表示放行，返回 { block, reason } 表示拦截。
 *
 * 事件：判定终点一律发 pi-permission:resolved（type 仅 allow/deny 两值，
 * 有无 UI 无关）；命中 ask 弹窗时另发 pi-permission:ask；
 * skill 忽略与总开关关闭不发（前者不是决策，后者扩展不存在）。
 */
export async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  st: GateState
): Promise<ToolCallEventResult | undefined> {
  const cfg = st.config
  const toolName = event.toolName
  // 总开关关闭：扩展不存在——不判定、不审计、不发事件
  if (!cfg.runtime.enabled) return undefined
  const input = event.input as unknown as Record<string, unknown>
  // 内外判定基准：session_start 记录的会话真实目录（避免子代理进程 ctx.cwd 漂移）
  const cwd = st.sessionCwd || ctx.cwd
  const { paths: rawPaths, command } = collectPathsAndCommand(toolName, input, cwd, cfg)

  // ── skill 读取直接忽略（不问不拦，无配置项）：纯 skill 读取直接放行 ──
  const paths = filterSkillPaths(rawPaths, cwd, st.skillRoots)
  if (command === undefined && rawPaths.length > 0 && paths.length === 0) {
    st.audit.review({
      ts: new Date().toISOString(),
      decision: 'allow',
      tool: toolName,
      note: 'skill 读取忽略'
    })
    return undefined
  }

  // ── 收集四面命中 ──
  const contributions: Contribution[] = []
  let parsed: ParsedCommand | undefined

  if (command !== undefined) {
    parsed = await parseCommand(command, cwd)
    if (parsed.degraded) {
      // 解析器不可用（未预热且 WASM 加载失败）：静态无法评估 → 保守弹窗
      contributions.push({
        face: 'bash',
        subject: command.replace(/\s+/g, ' ').trim(),
        value: 'ask'
      })
    }
    // bash 面：逐条片段评估（后匹配者胜）。每条片段一条命中，并记下命中的
    // 规则 pattern——供 classify 提示词说明「为什么把它交给模型判断」
    for (const seg of parsed.segments) {
      const hit = matchFace(cfg.bashRules, [[seg]], matchBashPattern)
      // classify 缓存按片段粒度，所以按片段而非整条命令记命中
      if (hit)
        contributions.push({ face: 'bash', subject: seg, value: hit.value, pattern: hit.pattern })
    }
    // 静态解析无法求值变量：含未展开变量（$VAR/${…}/$1）的片段命中规则不可靠，
    // 保守强制弹窗（宁可多问）——避免 `cat $HOME/x.env` 绕过 path 面 deny、
    // 变量命令绕过 bash deny；规则 deny 照常命中（取最严不受影响）
    for (const seg of parsed.askSegments)
      contributions.push({ face: 'bash', subject: seg, value: 'ask' })
    // bash 命令中提取的路径 token 并入 path 候选（§5）
    paths.push(...parsed.pathTokens)
  }

  // path 面 / external 面：按「每条路径 → 形态匹配 → 取最严」收集
  for (const p of paths) {
    // 内外判定与归一化都基于会话基准 cwd（回归：不再用会随进程漂移的 ctx.cwd）
    const forms = pathForms(cwd, p)
    const norm = normalizePath(cwd, p)
    if (contributions.some((e) => e.face === 'path' && e.subject === norm)) continue
    const pathHit = matchFace(cfg.pathRules, [forms], (pt, f) => globMatch(pt, f))
    if (pathHit)
      contributions.push({
        face: 'path',
        subject: norm,
        value: pathHit.value,
        pattern: pathHit.pattern
      })
    const outside = forms.filter((f) => !isInside(cwd, f))
    if (outside.length > 0) {
      const extHit = matchFace(cfg.externalRules, [outside], (pt, f) => globMatch(pt, f))
      if (extHit)
        contributions.push({
          face: 'external',
          subject: norm,
          value: extHit.value,
          pattern: extHit.pattern
        })
    }
  }

  // mcp 面（server / tool 粒度）
  const mcp = splitMcpName(toolName) ?? splitMcpFromNamespace(st, toolName)
  if (mcp) {
    const mcpHit = matchFace(cfg.mcpRules, [[`${mcp.server}/${mcp.tool}`]], (pt) =>
      mcpMatcher(mcp.server, mcp.tool)(pt)
    )
    if (mcpHit)
      contributions.push({
        face: 'mcp',
        subject: `${mcp.server}/${mcp.tool}`,
        value: mcpHit.value,
        pattern: mcpHit.pattern
      })
  }

  // ── 合成与执行 ──
  // 无 path/bash/mcp 命中时，工具兜底面在入口处合成条目并推入 contributions，
  // 让记忆检查/记忆写入/审计都能持到它（修复：兜底面工具的「本会话都允许」从未生效）
  if (contributions.length === 0) {
    const fallbackFace = toolFallback(cfg.toolRules, toolName)
    contributions.push({
      face: 'tool',
      subject: toolFallbackFaceSubject(fallbackFace),
      value: fallbackFace,
      pattern: 'permission["*"]'
    })
  }
  const fallback = toolFallback(cfg.toolRules, toolName)
  // 直接传入原数组：resolveDecision 会把 classify 条目原地突变为解析结果，
  // 后续 memoryAllows / askUser 需要读到解析后的值（classify 落 ask 的记忆）
  const decision = await resolveDecision(contributions, fallback, (c) =>
    // 把真实工具名与完整命令一并传给模型（只给片段会让它看不到判断依据）
    classifyContribution(ctx, cfg.classifier, st.cache, c, { toolName, command })
  )

  const debugData = {
    ts: new Date().toISOString(),
    tool: toolName,
    decision,
    contributions: contributions.map((c) => ({ face: c.face, subject: c.subject, value: c.value })),
    command: command !== undefined ? command : undefined,
    paths,
    input
  }

  if (decision === 'allow') {
    st.pi.events.emit('pi-permission:resolved', {
      type: 'allow',
      ...eventBase(toolName, command, paths, debugData.ts)
    })
    st.audit.review({
      ts: debugData.ts,
      decision,
      tool: toolName,
      note: ` contributors=${contributions.length}`
    })
    st.audit.debug(debugData)
    return undefined
  }

  if (decision === 'deny') {
    st.pi.events.emit('pi-permission:resolved', {
      type: 'deny',
      ...eventBase(toolName, command, paths, debugData.ts)
    })
    // review 通道保持单行紧凑，不摊开完整 input（SPEC §10）
    st.audit.review({
      ts: debugData.ts,
      decision,
      tool: toolName,
      command: command,
      paths,
      faces: debugData.contributions
    })
    st.audit.debug(debugData)
    return { block: true, reason: denyReason(contributions, false) }
  }

  // decision === 'ask'
  st.audit.debug(debugData)
  if (memoryAllows(toolName, contributions, st.memory)) {
    st.pi.events.emit('pi-permission:resolved', {
      type: 'allow',
      ...eventBase(toolName, command, paths, debugData.ts)
    })
    st.audit.review({
      ts: debugData.ts,
      decision: 'allow',
      tool: toolName,
      note: '会话审批记忆放行'
    })
    return undefined
  }
  if (!ctx.hasUI) {
    st.pi.events.emit('pi-permission:resolved', {
      type: 'deny',
      ...eventBase(toolName, command, paths, debugData.ts)
    })
    st.audit.review({ ts: debugData.ts, decision: 'deny', tool: toolName, note: '无 UI 拦截' })
    return { block: true, reason: noUiReason(contributions) }
  }
  // 供 deny 理由 / 会话审批记忆使用的命中（ask + classify 解析后命中）
  const cause = contributions.filter((e) => e.value === 'ask' || e.value === 'classify')
  // 标题仅传工具名与命令内容；命中详情不再进弹窗（审计日志与拒绝理由中保留）
  const content = command ?? (paths.length > 0 ? paths.join('\n') : undefined)
  // 命中 ask → 弹窗出现：发 ask 事件
  st.pi.events.emit('pi-permission:ask', eventBase(toolName, command, paths, debugData.ts))
  const choice = await askUser(ctx, { title: toolName, content })
  // 用户的选择也是一种终点：拒绝 → deny；允许/本会话都允许 → allow
  st.pi.events.emit('pi-permission:resolved', {
    type: choice === 'deny' ? 'deny' : 'allow',
    ...eventBase(toolName, command, paths, debugData.ts)
  })
  if (choice === 'deny') {
    st.audit.review({ ts: debugData.ts, decision: 'deny', tool: toolName, note: '用户拒绝' })
    return { block: true, reason: denyReason(cause, true) }
  }
  if (choice === 'session') rememberAllow(toolName, cause, st.memory)
  st.audit.review({
    ts: debugData.ts,
    decision: 'allow',
    tool: toolName,
    note: choice === 'session' ? '本会话都允许' : '用户允许（仅本次）'
  })
  return undefined
}

/** 通过 getAllTools 的 namespace 推断 MCP 归属（mcp_servers 尚未记录时的兜底） */
function splitMcpFromNamespace(
  st: GateState,
  toolName: string
): { server: string; tool: string } | undefined {
  const info = st.pi.getAllTools().find((t) => t.name === toolName)
  const ns = info?.namespace?.name
  if (!ns || !ns.startsWith('mcp__')) return undefined
  const server = ns.slice(5)
  return { server, tool: toolName }
}

/**
 * §8：启动前把被禁的工具从活动工具列表移除。
 * 判定：工具名兜底面取值 = deny，或（MCP 工具时）mcp 面 = deny。
 */
export function hideDeniedTools(pi: ExtensionAPI, cfg: ParsedConfig): string[] {
  const active = pi.getActiveTools()
  const removed: string[] = []
  const kept = active.filter((name) => {
    let value = toolFallback(cfg.toolRules, name)
    const mcp = splitMcpName(name)
    if (mcp) {
      const mcpHit = matchFace(cfg.mcpRules, [[`${mcp.server}/${mcp.tool}`]], (pt) =>
        mcpMatcher(mcp.server, mcp.tool)(pt)
      )
      if (mcpHit) {
        value = strictest([value, mcpHit.value]) as FaceValue
      }
    }
    if (value === 'deny') {
      removed.push(name)
      return false
    }
    return true
  })
  if (removed.length > 0) pi.setActiveTools(kept)
  return removed
}
