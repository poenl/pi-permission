import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * 纯逻辑引擎（无 pi 运行时依赖，可单测）。
 *
 * 覆盖 SPEC.md 核心语义：
 * - §4 决策流程（面匹配 → 后匹配者胜 → classify 解析 → 严格度合成）
 * - §5 各面语义（path / bash / external_directory / 工具名兜底）
 * - §7 命令精确解析（子 shell / 命令替换 / env 前缀 / 控制流体不进入）
 *
 * 语义取舍：工具名面按 SPEC §2「兜底策略」实现——仅当 path / bash /
 * external / mcp 四个面都没有命中任何规则时采用，命中面之间取最严者。
 * 这样默认 `permission["*"]: "ask"` 下 path 的 allow 与 bash 的
 * classify 依然可达，符合 SPEC 示例的意图。
 */

/** SPEC §3 支持 4 种配置值 */
export type FaceValue = 'allow' | 'ask' | 'deny' | 'classify'

/** 最终决策（classify 解析后的取值） */
export type Decision = 'allow' | 'ask' | 'deny'

/** 面：tool 是兜底面，path/bash/external/mcp 为规则命中面 */
export type FaceKey = 'tool' | 'path' | 'bash' | 'external' | 'mcp'

/** 一条保序规则：pattern → value（依赖 JSON 对象键序实现「后匹配者胜」） */
export type Rule = readonly [pattern: string, value: FaceValue]

/** 单条命中：某面上的某条具体内容（路径 / 命令片段 / 工具名）与其命中值 */
export interface Contribution {
  face: FaceKey
  subject: string
  value: FaceValue
  /** 命中的规则原文（pattern）；用于告诉 classify 模型「为什么把它交给模型判断」 */
  pattern?: string
}

/** 严格度（SPEC §4）：deny > ask > classify > allow */
const RANK: Record<FaceValue, number> = { allow: 0, classify: 1, ask: 2, deny: 3 }

/** 多个值合成：最严者胜 */
export function strictest(values: FaceValue[]): FaceValue | undefined {
  let worst: FaceValue | undefined
  for (const v of values) {
    if (worst === undefined || RANK[v] > RANK[worst]) worst = v
  }
  return worst
}

// ─── 通配符（§5：'*' 任意字符，'?' 单字符） ────────────────────────────

const GLOB_CACHE = new Map<string, RegExp>()

/** '*' 编译为跨任意字符（含 '/'，对应 external_directory 的贪婪跨层级），'?' 单字符 */
function globRegExp(pattern: string): RegExp {
  const cached = GLOB_CACHE.get(pattern)
  if (cached) return cached
  const src = pattern
    .replace(/[.+^${}()[\]\\]/g, '\\$&')
    .replace(/\*/g, '[\\s\\S]*')
    .replace(/\?/g, '[\\s\\S]')
  const re = new RegExp(`^${src}$`)
  GLOB_CACHE.set(pattern, re)
  return re
}

export function globMatch(pattern: string, text: string): boolean {
  return globRegExp(pattern).test(text)
}

// ─── 路径处理（§5 path / external 面） ────────────────────────────────

/** 展开 ~ 前缀并把相对路径按 cwd 词法归一化为绝对路径（不要求路径存在） */
export function normalizePath(cwd: string, raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2))
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

/** 路径存在时返回 symlink 还原后的绝对路径，否则 undefined */
export function realpathForm(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

/**
 * 路径统一归一化入口：返回 [归一化绝对路径, realpath（若不同）]。
 * 所有进入判定的路径（工具输入 / bash token / 配置模式）都过这里，
 * 原样拼写不再参与任何判定（回归修复：相对路径曾被误判为项目外、
 * 去重曾把归一化形态挤出导致 undefined）。
 */
export function pathForms(cwd: string, raw: string): string[] {
  const norm = normalizePath(cwd, raw)
  const real = realpathForm(norm)
  return real && real !== norm ? [norm, real] : [norm]
}

/** path 是否位于 dir 内（或等于 dir 自身） */
export function isInside(dir: string, path: string): boolean {
  const d = dir.endsWith(sep) ? dir : dir + sep
  return path === dir || path.startsWith(d)
}

/**
 * bash 面模式匹配（§5）：'*' 任意字符、'?' 单字符；
 * 以 " *" 结尾的模式也匹配不带参数的命令本身（"rm -rf *" ↔ "rm -rf"）。
 */
export function matchBashPattern(pattern: string, segment: string): boolean {
  const seg = segment.replace(/\s+/g, ' ').trim()
  // 模式内乱序空白同样归一化后再比对，避免 'rm  -rf *' 与 'rm -rf *' 不等价
  const pat = pattern.replace(/\s+/g, ' ').trim()
  if (globMatch(pat, seg)) return true
  if (pat.endsWith(' *')) return globMatch(pat.slice(0, -2).trim(), seg)
  return false
}

/**
 * 面规则匹配（§4 步骤 2）：对同一份内容的多个形态（如路径的拼写/realpath）
 * 按「后匹配者胜」取最后一条命中的规则；多条内容之间取最严者。
 * 无任何命中 → undefined（该面对决策中性）。
 * 返回值同时带回命中的 rules pattern，供 classify 提示词说明判定依据。
 */
export function matchFace(
  rules: Rule[],
  subjects: string[][],
  match: (pattern: string, subject: string) => boolean
): { value: FaceValue; pattern: string } | undefined {
  let worst: { value: FaceValue; pattern: string } | undefined
  for (const forms of subjects) {
    let winner: { value: FaceValue; pattern: string } | undefined
    for (const [pattern, value] of rules) {
      if (forms.some((f) => match(pattern, f))) winner = { value, pattern }
    }
    if (winner && (worst === undefined || RANK[winner.value] > RANK[worst.value])) worst = winner
  }
  return worst
}
