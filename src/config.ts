import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import type { FaceValue, Rule } from './engine'

/**
 * 配置加载与校验（SPEC §3 / §9）。
 *
 * - 位置：全局 `~/.pi/agent/extensions/pi-permission/config.json` + 项目
 *   `.pi/extensions/pi-permission-system/config.json`（沿用参考扩展的项目
 *   目录命名，兼容已有项目配置），叶级深合并、项目级优先；数组整体覆盖。
 * - 非法配置 fail-closed：所有 `allow` 降级为 `ask`，非法 classifier 块丢弃
 *   （classify 落 `ask`）。
 * - 键结构与键名沿用 SPEC：permission / classifier /
 *   shellTools / 各运行时开关，均写在 config.json 顶层。
 */

export interface ClassifierConfig {
  provider: string
  model: string
  timeoutMs: number
  threshold: number
}

/** §9 运行时开关（config.json 顶层键；/permission 命令可改会话内值） */
export interface RuntimeToggles {
  /** 总开关：false = 整个扩展不存在（不判定、不审计、不发事件） */
  enabled: boolean
  /** debug 审计通道（verbose） */
  debugLog: boolean
  /** review 审计通道（默认开） */
  permissionReviewLog: boolean
}

export interface ParsedConfig {
  /** 工具名面（含 "*"），保序，支持通配符匹配工具名 */
  toolRules: Rule[]
  pathRules: Rule[]
  bashRules: Rule[]
  externalRules: Rule[]
  /** MCP 面：键为 "*" / "<server>" / "<server>/<tool>"（"-" 与 "_" 等价） */
  mcpRules: Rule[]
  /** classifier 块；缺失/非法 → classify 一律落 ask（§3/§6） */
  classifier?: ClassifierConfig
  /** §9：这些别名 shell 工具套用 bash 规则 */
  shellTools: string[]
  /** 运行时开关（会话内可被 /permission 修改，为本对象的活引用） */
  runtime: RuntimeToggles
  /** 配置是否非法（已 fail-closed 处理） */
  invalid: boolean
}

const FACE_VALUES = new Set<FaceValue>(['allow', 'ask', 'deny', 'classify'])

const DEFAULT_RUNTIME: RuntimeToggles = {
  enabled: true,
  debugLog: false,
  permissionReviewLog: true
}

/** 配置模式归一化：展开 ~ 前缀（'~/*' → '/Users/…/*'），与路径同一形态域匹配 */
function normalizePattern(pattern: string): string {
  if (pattern === '~') return homedir()
  if (pattern.startsWith('~/')) return resolve(homedir(), pattern.slice(2))
  return pattern
}

/** 全局配置：扩展自身目录下的 config.json（与 sibling 扩展 pi-permission-system 惯例一致） */
const globalConfigPath = () => resolve(homedir(), '.pi/agent/extensions/pi-permission/config.json')

/** 项目级配置：沿用 pi-permission-system 的项目目录命名，兼容已有项目配置 */
const projectConfigPath = (cwd: string) =>
  resolve(cwd, '.pi/extensions/pi-permission-system/config.json')

/** 测试可注入的两层路径 */
export interface ConfigPaths {
  global?: string
  project?: string
}

/** 文件指纹：mtime（毫秒）；文件不存在用 missing 哨兵 */
function fileStamp(path: string): string {
  try {
    return String(statSync(path).mtimeMs)
  } catch {
    return 'missing'
  }
}

/** 热重载缓存：上次解析结果 + 两层路径/mtime 指纹；文件被改后指纹变化即重新解析 */
let hotCache: { key: string; cfg: ParsedConfig } | undefined

/** 读一个 config.json；不存在 → null；坏 JSON / 非对象 → 解析错误标记 */
function readConfigFile(path: string): { data: Record<string, unknown> | null; bad: boolean } {
  try {
    const raw = readFileSync(path, 'utf8')
    const data = JSON.parse(raw)
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      return { data: null, bad: true }
    return { data: data as Record<string, unknown>, bad: false }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { data: null, bad: false }
    return { data: null, bad: true }
  }
}

/**
 * 叶级深合并：对象递归合并、数组与标量由 overlay 整体覆盖（项目级优先）。
 */
function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    const b = out[k]
    if (
      b &&
      typeof b === 'object' &&
      !Array.isArray(b) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

/** 解析一个「pattern → value」保序规则表；返回 null 表示该块类型非法 */
function parseRules(raw: unknown, out: { invalid: boolean }): Rule[] | null {
  if (raw === undefined) return []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    out.invalid = true
    return null
  }
  const rules: Rule[] = []
  for (const [pattern, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof pattern !== 'string') {
      out.invalid = true
      continue
    }
    if (typeof value !== 'string' || !FACE_VALUES.has(value as FaceValue)) {
      out.invalid = true // 未知的值直接丢弃（保守：宁缺勿滥）
      continue
    }
    rules.push([normalizePattern(pattern), value as FaceValue])
  }
  return rules
}

/** 校验并提升 classifier 块；非法 → 返回 undefined 并标记 invalid */
function parseClassifier(raw: unknown, out: { invalid: boolean }): ClassifierConfig | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    out.invalid = true
    return undefined
  }
  const o = raw as Record<string, unknown>
  const provider = o.provider
  const model = o.model
  const timeoutMs = o.timeoutMs ?? 15_000
  const threshold = o.threshold ?? 0.5
  const ok =
    (provider === undefined || typeof provider === 'string') &&
    (model === undefined || typeof model === 'string') &&
    typeof timeoutMs === 'number' &&
    timeoutMs > 0 &&
    typeof threshold === 'number' &&
    threshold >= 0 &&
    threshold <= 1
  if (!ok || typeof provider !== 'string' || typeof model !== 'string') {
    out.invalid = true
    return undefined
  }
  return { provider, model, timeoutMs, threshold }
}

function parseStringArray(raw: unknown, out: { invalid: boolean }): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    out.invalid = true
    return []
  }
  return raw as string[]
}

/** 配置非法时的 fail-closed：所有 allow 降级为 ask（SPEC §3） */
function failClosed(rules: Rule[]): Rule[] {
  return rules.map(([pattern, value]) => [pattern, value === 'allow' ? 'ask' : value] as Rule)
}

/**
 * 加载并合并两层配置：全局扩展目录 config.json（低）+ 项目
 * `.pi/extensions/pi-permission-system/config.json`（高，叶级覆盖）。
 * 非法配置已按 fail-closed 就地处理：allow → ask，非法 classifier 块丢弃
 * （classify 落 ask）。paths 用于测试注入临时配置文件路径。
 * 热重载：按两层文件的 mtime 指纹缓存，文件被改后下一次调用即重读
 * （改 config.json 无需 /reload）；`bypassCache` 跳过缓存强解析——
 * session_start 用，保证运行时开关每个会话从文件默认值重新开始。
 */
export function loadConfig(
  cwd: string,
  paths?: ConfigPaths,
  opts?: { bypassCache?: boolean }
): ParsedConfig {
  const gp = paths?.global ?? globalConfigPath()
  const pp = paths?.project ?? projectConfigPath(cwd)
  const cacheKey = `${gp}\u0000${fileStamp(gp)}\u0000${pp}\u0000${fileStamp(pp)}`
  if (!opts?.bypassCache && hotCache && hotCache.key === cacheKey) return hotCache.cfg
  const globalSettings = readConfigFile(gp)
  const projectSettings = readConfigFile(pp)
  const invalid = globalSettings.bad || projectSettings.bad ? true : false
  const merged = deepMerge(globalSettings.data ?? {}, projectSettings.data ?? {})

  const out = { invalid }
  const permissionRaw = merged['permission']
  const toolRules: Rule[] = []
  const ruleSets: Record<'path' | 'bash' | 'external' | 'mcp', Rule[]> = {
    path: [],
    bash: [],
    external: [],
    mcp: []
  }
  if (
    permissionRaw !== undefined &&
    (typeof permissionRaw !== 'object' || permissionRaw === null || Array.isArray(permissionRaw))
  ) {
    out.invalid = true
  } else if (permissionRaw) {
    for (const [key, value] of Object.entries(permissionRaw as Record<string, unknown>)) {
      if (key === 'path' || key === 'bash' || key === 'external_directory' || key === 'mcp') {
        const rules = parseRules(value, out)
        if (rules) {
          const faceKey = key === 'external_directory' ? 'external' : key
          ruleSets[faceKey] = rules
        }
      } else {
        // 工具名面：字符串值
        if (typeof value !== 'string' || !FACE_VALUES.has(value as FaceValue)) {
          out.invalid = true
          continue
        }
        toolRules.push([key, value as FaceValue])
      }
    }
  }

  const classifier = parseClassifier(merged['classifier'], out)
  const runtime: RuntimeToggles = {
    enabled: merged['enabled'] === undefined ? DEFAULT_RUNTIME.enabled : merged['enabled'] === true,
    debugLog:
      merged['debugLog'] === undefined ? DEFAULT_RUNTIME.debugLog : merged['debugLog'] === true,
    permissionReviewLog:
      merged['permissionReviewLog'] === undefined
        ? DEFAULT_RUNTIME.permissionReviewLog
        : merged['permissionReviewLog'] === true
  }

  const parsed: ParsedConfig = {
    toolRules,
    pathRules: ruleSets['path'] as Rule[],
    bashRules: ruleSets['bash'] as Rule[],
    externalRules: ruleSets['external'] as Rule[],
    mcpRules: ruleSets['mcp'] as Rule[],
    classifier,
    shellTools: parseStringArray(merged['shellTools'], out),
    runtime,
    invalid: out.invalid
  }

  if (parsed.invalid) {
    // fail-closed：非法配置下所有 allow 降级为 ask
    parsed.toolRules = failClosed(parsed.toolRules)
    parsed.pathRules = failClosed(parsed.pathRules)
    parsed.bashRules = failClosed(parsed.bashRules)
    parsed.externalRules = failClosed(parsed.externalRules)
    parsed.mcpRules = failClosed(parsed.mcpRules)
    parsed.classifier = undefined // classify → ask
  }
  // 存入热缓存：文件未变时后续调用直接复用（热重载）
  hotCache = { key: cacheKey, cfg: parsed }
  return parsed
}
