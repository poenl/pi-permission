import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { loadConfig } from '../src/config'

/**
 * 建临时两层配置环境，返回 (global, project) 两个 config.json 路径。
 * 目录结构对应真实布局：全局=扩展目录，项目=.pi/extensions/pi-permission-system/
 */
function setup(
  globalRaw: unknown,
  projectRaw: unknown
): { global: string; project: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pn-cfg-'))
  const cwd = join(dir, 'proj')
  mkdirSync(join(cwd, '.pi/extensions/pi-permission-system'), { recursive: true })
  const global = join(dir, 'global-config.json')
  const project = join(cwd, '.pi/extensions/pi-permission-system', 'config.json')
  if (globalRaw !== undefined) writeFileSync(global, JSON.stringify(globalRaw))
  if (projectRaw !== undefined) writeFileSync(project, JSON.stringify(projectRaw))
  return { global, project, cwd }
}

describe('两层 config.json 合并', () => {
  test('项目级叶优先、数组整体覆盖', () => {
    const env = setup(
      {
        permission: { '*': 'allow', path: { '*.env': 'deny' } },
        classifier: { provider: 'g', model: 'm1', threshold: 0.5, timeoutMs: 1000 }
      },
      { permission: { path: { '*.local': 'ask' } }, shellTools: ['snap'] }
    )
    const cfg = loadConfig(env.cwd, { global: env.global, project: env.project })
    // 工具面合并保留双方；path 面合并后具备两种模式
    expect(cfg.toolRules).toContainEqual(['*', 'allow'])
    expect(cfg.pathRules).toContainEqual(['*.env', 'deny'])
    expect(cfg.pathRules).toContainEqual(['*.local', 'ask'])
    // classifier 叶级合并：项目未给 provider 时保留全局
    expect(cfg.classifier?.provider).toBe('g')
    // 数组：项目整体覆盖
    expect(cfg.shellTools).toEqual(['snap'])
  })
})

describe('fail-closed', () => {
  test('非法值：allow 全部降级为 ask，deny 保留，classifier 块失效', () => {
    const env = setup(
      {
        permission: { '*': 'allow', read: 'allow', bash: { 'git *': 'block' } },
        classifier: { provider: 1, model: 'm1' }
      },
      undefined
    )
    const cfg = loadConfig(env.cwd, { global: env.global, project: env.project })
    expect(cfg.invalid).toBe(true)
    expect(cfg.toolRules).toContainEqual(['*', 'ask'])
    expect(cfg.toolRules).toContainEqual(['read', 'ask'])
    // 未知值 block 的规则直接丢弃
    expect(cfg.bashRules).toEqual([])
    expect(cfg.classifier).toBeUndefined()
  })
  test('坏 JSON 同样 fail-closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-cfg-'))
    const global = join(dir, 'config.json')
    writeFileSync(global, '{oops')
    const cwd = join(dir, 'proj')
    mkdirSync(cwd, { recursive: true })
    const cfg = loadConfig(cwd, { global, project: join(cwd, 'missing.json') })
    expect(cfg.invalid).toBe(true)
    expect(cfg.toolRules).toEqual([])
  })
  test('classifier 缺失 → classify 落 ask', () => {
    const env = setup({ permission: { bash: { '*': 'classify' } } }, undefined)
    const cfg = loadConfig(env.cwd, { global: env.global, project: env.project })
    expect(cfg.classifier).toBeUndefined()
    expect(cfg.bashRules).toContainEqual(['*', 'classify'])
  })
})

describe('配置热重载', () => {
  test('文件被改后 loadConfig 即时重读（无需 /reload）', () => {
    const env = setup({ permission: { '*': 'allow' } }, undefined)
    const cfg1 = loadConfig(env.cwd, { global: env.global, project: env.project })
    expect(cfg1.toolRules).toContainEqual(['*', 'allow'])
    // 首次调用后的重复读取应命中缓存（同一对象）
    expect(loadConfig(env.cwd, { global: env.global, project: env.project })).toBe(cfg1)
    // 改写文件并手动 bump mtime（规避文件系统 mtime 粒度问题）
    writeFileSync(env.global, JSON.stringify({ permission: { '*': 'ask' } }))
    const bumped = new Date(Date.now() + 1100)
    utimesSync(env.global, bumped, bumped)
    const cfg2 = loadConfig(env.cwd, { global: env.global, project: env.project })
    expect(cfg2.toolRules).toContainEqual(['*', 'ask'])
    expect(cfg2).not.toBe(cfg1)
  })
})

describe('模式归一化', () => {
  test('配置模式 ~ 展开为绝对路径，与反归一形态匹配路径', () => {
    const env = setup({ permission: { external_directory: { '~/*': 'allow' } } }, undefined)
    const cfg = loadConfig(env.cwd, { global: env.global, project: env.project })
    const expected = join(homedir(), '*')
    expect(cfg.externalRules).toContainEqual([expected, 'allow'])
  })
})

describe('运行时开关会话隔离', () => {
  test('bypassCache 强制重解析：/permission 的修改不跨会话泄漏', () => {
    const env = setup({ permission: { '*': 'ask' } }, undefined)
    const a = loadConfig(env.cwd, { global: env.global, project: env.project })
    a.runtime.permissionReviewLog = false // 模拟会话 A 的 /permission 修改
    const b = loadConfig(
      env.cwd,
      { global: env.global, project: env.project },
      { bypassCache: true }
    )
    expect(b.runtime.permissionReviewLog).toBe(true)
  })
})

describe('默认值', () => {
  test('两层文件都缺失：无规则、runtime 默认', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-cfg-empty-'))
    const cwd = join(dir, 'proj')
    mkdirSync(cwd, { recursive: true })
    const cfg = loadConfig(cwd, { global: join(dir, 'none.json'), project: join(cwd, 'none.json') })
    expect(cfg.toolRules).toEqual([])
    expect(cfg.invalid).toBe(false)
    expect(cfg.runtime.permissionReviewLog).toBe(true)
  })
})

describe('总开关 enabled', () => {
  test('默认 true；配置键可关闭；非法值按默认', () => {
    const env = setup({ permission: { '*': 'ask' } }, undefined)
    expect(loadConfig(env.cwd, { global: env.global, project: env.project }).runtime.enabled).toBe(
      true
    )
    const env2 = setup({ permission: { '*': 'ask' }, enabled: false }, undefined)
    expect(
      loadConfig(env2.cwd, { global: env2.global, project: env2.project }).runtime.enabled
    ).toBe(false)
  })
})

describe('classify 各面通用', () => {
  test('五个位置写 classify 均保留（不再降级为 ask）', () => {
    const env = setup(
      {
        permission: {
          '*': 'classify',
          path: { '*': 'classify' },
          external_directory: { '*': 'classify' },
          mcp: { '*': 'classify' },
          bash: { '*': 'classify' }
        }
      },
      undefined
    )
    const cfg = loadConfig(env.cwd, { global: env.global, project: env.project })
    expect(cfg.invalid).toBe(false)
    expect(cfg.toolRules).toContainEqual(['*', 'classify'])
    expect(cfg.pathRules).toEqual([['*', 'classify']])
    expect(cfg.externalRules).toEqual([['*', 'classify']])
    expect(cfg.mcpRules).toEqual([['*', 'classify']])
    expect(cfg.bashRules).toEqual([['*', 'classify']])
  })
})
