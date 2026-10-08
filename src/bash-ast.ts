import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'

import { realpathForm } from './engine'

/**
 * bash 命令解析（tree-sitter-bash AST）。
 *
 * 为什么用 AST：文本扫描无法区分「参数是正则/程序」还是「参数是路径」——
 * `sed -n '/^## 6. classify/,/^## 7/p' SPEC.md` 的正则参数会被当成绝对路径，
 * 进而误判为「工作目录外」。AST 能按节点类型与位置区分：
 *
 * - 段（segments）：每个 `command` 节点的文本（剥去行首 VAR=… 赋值前缀），
 *   嵌套命令替换/子 shell/管道里的命令各自成段 —— 供 bash 面规则匹配
 * - 路径候选（pathTokens）：命令参数与重定向目标，按「形状」判定；
 *   不像路径的裸词（如 `id_rsa`）靠磁盘存在性探测决定（存在才算）
 * - 内联 pattern：grep/sed/awk 这类「第一个位置参数是模式」的命令，
 *   按位置跳过该参数（PATTERN_FIRST_COMMANDS），不靠字符集猜
 * - 未展开变量（askSegments）：$VAR / ${…} / 位置参数所在段交给调用方强制 ask
 */

/** tree-sitter 节点的最小接口（只用到这些成员，避免耦合其类型导出） */
export interface AstNode {
  readonly type: string
  readonly text: string
  readonly startIndex: number
  readonly endIndex: number
  readonly childCount: number
  child(index: number): AstNode | null
}

/** web-tree-sitter Parser 的最小接口 */
interface TsParser {
  parse(input: string): { rootNode: AstNode; delete(): void } | null
}

/** 解析结果 */
export interface ParsedCommand {
  /** 可被 bash 规则匹配的命令片段（去重、剥去赋值前缀） */
  segments: string[]
  /** 路径候选 token（命令参数 + 重定向目标，形状判定 + 裸词存在性探测） */
  pathTokens: string[]
  /** 含未展开变量的片段：静态无法求值 → 调用方保守强制 ask */
  askSegments: string[]
  /** true = 解析器不可用（未预热且加载失败）→ 调用方保守处理 */
  degraded: boolean
}

// ─── 解析器生命周期 ────────────────────────────────────────────────────

let parserPromise: Promise<TsParser> | undefined
let warmParser: TsParser | undefined

async function initParser(): Promise<TsParser> {
  const { Parser, Language } = await import('web-tree-sitter')
  const req = createRequire(import.meta.url)
  // WASM 路径按包导出解析（与 @gotgenes/pi-permission-system 同法）
  await Parser.init({ locateFile: () => req.resolve('web-tree-sitter/web-tree-sitter.wasm') })
  const bash = await Language.load(req.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
  const parser = new Parser()
  parser.setLanguage(bash)
  return parser as unknown as TsParser
}

/** 取解析器（惰性初始化）；失败不缓存，下次调用重试 */
function getParser(): Promise<TsParser> {
  parserPromise ??= initParser().catch((err: unknown) => {
    parserPromise = undefined
    throw err
  })
  return parserPromise
}

/** session_start 预热：成功则后续调用同步可用；失败保持冷态（调用时降级） */
export async function warmBashParser(): Promise<void> {
  try {
    warmParser = await getParser()
  } catch {
    warmParser = undefined
  }
}

// ─── 解析入口 ──────────────────────────────────────────────────────────

/** 解析一条 bash 命令 */
export async function parseCommand(command: string, cwd: string): Promise<ParsedCommand> {
  let parser = warmParser
  if (!parser) {
    try {
      parser = await getParser()
      warmParser = parser
    } catch {
      return degradedResult(command)
    }
  }
  const tree = parser.parse(command)
  if (!tree) return degradedResult(command)
  try {
    const state: WalkState = {
      src: command,
      cwd,
      parser,
      depth: 0,
      segments: new Set<string>(),
      ask: new Set<string>(),
      tokens: new Set<string>()
    }
    walk(tree.rootNode, state)
    return {
      segments: [...state.segments],
      pathTokens: [...state.tokens],
      askSegments: [...state.ask],
      degraded: false
    }
  } finally {
    tree.delete?.()
  }
}

/** 解析器不可用时的降级结果：整串当一段，且标记 degraded（调用方应保守弹窗） */
function degradedResult(command: string): ParsedCommand {
  return {
    segments: [command.replace(/\s+/g, ' ').trim()],
    pathTokens: [],
    askSegments: [],
    degraded: true
  }
}

interface WalkState {
  src: string
  cwd: string
  parser: TsParser
  /** 嵌套深度（heredoc 体内命令递归解析用） */
  depth: number
  segments: Set<string>
  ask: Set<string>
  tokens: Set<string>
}

/** 嵌套解析深度上限（防极端输入） */
const MAX_DEPTH = 8

// ─── AST 遍历 ──────────────────────────────────────────────────────────

/**
 * 遍历 AST：收集命令段与路径候选。
 * 每个 command 节点自成一段（重定向只贡献目标 token，不进段文本）。
 */
function walk(node: AstNode, state: WalkState): void {
  if (node.type === 'command') {
    pushSegment(node, state)
    collectCommandTokens(node, state)
  } else if (node.type === 'file_redirect') {
    // 重定向目标在这类节点里（redirected_statement 自身无操作，靠遍历子节点到达）
    collectRedirectTokens(node, state)
  } else if (node.type === 'heredoc_redirect') {
    // 插值 heredoc（<< EOF）的体内文本会被 shell 执行 → 递归解析成段；
    // 引号限定符（<< 'EOF'）是字面数据，不评估（§7）
    parseHeredocBody(node, state)
  } else if (node.type === 'for_statement') {
    collectForOperands(node, state)
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) walk(child, state)
  }
}

/** 段文本：从第一个非赋值子节点起截取（§7：行首 VAR=… 赋值前缀剥离后再匹配） */
function pushSegment(node: AstNode, state: WalkState): void {
  let text = node.text
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'variable_assignment') continue
    text = state.src.slice(child.startIndex, node.endIndex)
    break
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return
  state.segments.add(normalized)
  if (hasUnexpandedVar(node)) state.ask.add(normalized)
}

/** 段内是否有未展开变量（$VAR / ${…} / $1）；$(…)/$((…))/$'…' 不算（已可求值） */
function hasUnexpandedVar(node: AstNode): boolean {
  if (node.type === 'simple_expansion' || node.type === 'expansion') return true
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && hasUnexpandedVar(child)) return true
  }
  return false
}

// ─── 路径候选收集 ──────────────────────────────────────────────────────

/**
 * 「第一个位置参数是模式」的命令：按位置跳过内联 pattern/脚本，
 * 避免把正则或程序当路径（文本扫描做不到这一点）。
 * 表里存在 = 该命令首个位置参数是 pattern/脚本；值 = 该命令中后面紧跟一个值的选项
 * （值不是路径，按表消费）。
 */
const PATTERN_FIRST_COMMANDS: Record<string, Set<string>> = {
  grep: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--regexp', '--file']),
  egrep: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--regexp', '--file']),
  fgrep: new Set(['-e', '-f']),
  rg: new Set(['-e', '-f', '-g', '-t', '-m', '-A', '-B', '-C', '--regexp', '--file']),
  ag: new Set([]),
  sed: new Set(['-e', '-f', '-i']),
  awk: new Set(['-f', '-v']),
  gawk: new Set(['-f', '-v']),
  perl: new Set(['-e', '-f']),
  tr: new Set([])
}

/** 收集命令节点的参数路径候选 */
function collectCommandTokens(node: AstNode, state: WalkState): void {
  const name = commandName(node)
  const valueOptions = name !== undefined ? PATTERN_FIRST_COMMANDS[name] : undefined
  let patternPositions = valueOptions ? 1 : 0 // 还需跳过的位置参数个数
  let expectValue = false

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (
      child.type === 'command_name' ||
      child.type === 'variable_assignment' ||
      child.type === 'file_redirect' ||
      child.type === 'heredoc_redirect'
    ) {
      continue
    }
    const text = child.text
    if (expectValue) {
      expectValue = false // 选项的值：本体不是路径
      continue
    }
    if (text.startsWith('-')) {
      if (valueOptions?.has(text)) expectValue = true
      continue
    }
    if (patternPositions > 0) {
      patternPositions--
      continue
    }
    addToken(text, state)
  }
}

/** 收集重定向目标（`> out.txt`、`2>> log`；heredoc 无文件目标） */
function collectRedirectTokens(node: AstNode, state: WalkState): void {
  if (node.type === 'heredoc_redirect') return
  // 结构：[file_descriptor?] operator target
  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'word' || child.type === 'string' || child.type === 'raw_string') {
      addToken(child.text, state)
      return
    }
  }
}

/**
 * 插值 heredoc 体：把体内文本当命令再解析一遍（旧文本解析器的行为，
 * 避免 `bash << EOF` 之类的绕过）。引号限定符的 heredoc 不评估。
 */
function parseHeredocBody(node: AstNode, state: WalkState): void {
  if (state.depth >= MAX_DEPTH) return
  let marker: string | undefined
  let body: AstNode | undefined
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'heredoc_start') marker = child.text
    if (child.type === 'heredoc_body') body = child
  }
  if (marker === undefined || body === undefined) return
  // 引号/反斜杠限定符 → 字面数据
  if (/^['"\\]/.test(marker)) return
  const sub = state.parser.parse(body.text)
  if (!sub) return
  try {
    // 子树的起止下标基于体内文本，src 必须换成它（否则切片越界/串行）
    walk(sub.rootNode, { ...state, src: body.text, depth: state.depth + 1 })
  } finally {
    sub.delete?.()
  }
}

/** 收集 `for x in a b` 的 in 列表（循环真正遍历的文件）；case 的 pattern 不是被访问的路径，不收 */
function collectForOperands(node: AstNode, state: WalkState): void {
  let inSeen = false
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'in') {
      inSeen = true
      continue
    }
    if (!inSeen) continue
    if (child.type === 'word' || child.type === 'string' || child.type === 'raw_string')
      addToken(child.text, state)
  }
}

/** 命令名：首个 command_name 子节点的 basename（/usr/bin/sed 与 sed 同样对待） */
function commandName(node: AstNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'command_name') return basename(child.text)
  }
  return undefined
}

// ─── token 形状判定（对齐 @gotgenes 的三值思路） ────────────────────────

/** URL（非路径） */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i
/** Windows 盘符绝对路径（C:/… 或 C:\…） */
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:[/\\]/

/**
 * 共享排除前置：语法上不可能表示文件路径的 token。
 * 注意：不按 glob/正则元字符排除——shell 的 glob 与正则字符类写法相同，
 * 用元字符判会漏掉真实路径（如 `/etc/[p]asswd`）。
 */
function rejectNonPathToken(token: string): boolean {
  if (!token) return true
  if (token.startsWith('-')) return true
  const eq = token.indexOf('=')
  const slash = token.indexOf('/')
  if (eq !== -1 && (slash === -1 || eq < slash)) return true // FOO=/bar（赋值）而非 /foo=bar
  if (URL_PATTERN.test(token)) return true
  if (token.startsWith('@') && !token.startsWith('@/')) return true // @scope/pkg
  return false
}

/** 形状上「像路径」：绝对/家目录/相对/上级/盘符 */
function isPathShaped(token: string): boolean {
  return (
    token.startsWith('~') ||
    token.startsWith('.') ||
    token.includes('/') ||
    token.includes('..') ||
    WINDOWS_DRIVE_PATTERN.test(token)
  )
}

/** 加一个候选：形状像路径的直接收；裸词靠磁盘存在性探测（存在才算） */
function addToken(raw: string, state: WalkState): void {
  const token = unquote(raw)
  if (rejectNonPathToken(token)) return
  if (isPathShaped(token)) {
    state.tokens.add(token)
    return
  }
  // 裸词（如 id_rsa）：只有确实存在于 cwd 下才算路径候选
  if (realpathForm(resolve(state.cwd, token)) !== undefined) state.tokens.add(token)
}

/** 去掉外层引号（raw_string / string 节点的文本带引号） */
function unquote(raw: string): string {
  const first = raw[0]
  const last = raw[raw.length - 1]
  if (raw.length >= 2 && (first === "'" || first === '"') && last === first) return raw.slice(1, -1)
  return raw
}
