import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  globMatch,
  isInside,
  matchBashPattern,
  matchFace,
  pathForms,
  realpathForm,
  strictest
} from '../src/engine'
import type { Rule } from '../src/engine'

/** 快捷建规则表（保持声明顺序，靠「后匹配者胜」） */
const rules = (pairs: [string, string][]): Rule[] => pairs as Rule[]

describe('通配符（§5）', () => {
  test('* 跨层级匹配', () => {
    expect(globMatch('*.env', 'a/b.env')).toBe(true)
    expect(globMatch('/tmp/*', '/tmp/x/y')).toBe(true) // external 贪婪跨层级
    expect(globMatch('/tmp/*', '/tmpx')).toBe(false)
  })
  test('? 单字符', () => {
    expect(globMatch('file?', 'file1')).toBe(true)
    expect(globMatch('file?', 'file12')).toBe(false)
  })
})

describe('路径处理（§5 path 面）', () => {
  const cwd = '/home/user/proj'
  test('相对路径按工作目录归一化', () => {
    expect(pathForms(cwd, './x/../y.env')).toContain(join(cwd, 'y.env'))
    expect(pathForms(cwd, '~/me')[0]).toBe(resolve(homedir(), 'me'))
  })
  test('symlink 还原后也参与匹配', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pn-perm-'))
    const target = join(dir, 'secret.env')
    writeFileSync(target, '')
    const link = join(dir, 'link.env')
    symlinkSync(target, link)
    // macOS 的 /var 本身是符号链接，对 target 和 link 取 real 比对
    const real = realpathForm(link) as string
    expect(real).toBe(realpathForm(target))
    // "*.env" 命中 link 与 target 两种形态
    expect(globMatch('*.env', real)).toBe(true)
  })
  test('isInside', () => {
    expect(isInside('/home/u', '/home/u/a')).toBe(true)
    expect(isInside('/home/u', '/home/ua')).toBe(false)
    expect(isInside('/home/u', '/home/u')).toBe(true)
  })
  test('回归：pathForms 只返回绝对形态、无 undefined 空洞（修复 工作目录外=undefined）', () => {
    const abs = '/Users/moenl/Projects/pi-kit/extensions/awake.ts'
    const forms = pathForms('/Users/moenl/Projects/pi-kit', abs)
    expect(forms[0]).toBe(abs)
    for (const f of forms) expect(typeof f).toBe('string')
  })
})

describe('bash 面模式匹配（§5）', () => {
  test('以 " *" 结尾的模式也匹配不带参数的命令本身', () => {
    expect(matchBashPattern('rm -rf *', 'rm -rf')).toBe(true)
    expect(matchBashPattern('rm -rf *', 'rm -rf /')).toBe(true)
    expect(matchBashPattern('rm -rf *', 'rm')).toBe(false)
    expect(matchBashPattern('sudo *', 'sudo apt install')).toBe(true)
  })
  test('乱序空白不影响匹配', () => {
    expect(matchBashPattern('rm  -rf *', 'rm -rf x')).toBe(true)
  })
  test('双引号内替换段占位后引号平衡不受影响', () => {
    expect(matchBashPattern('echo *', 'echo " "')).toBe(true)
  })
})

describe('面匹配与严格度（§4）', () => {
  test('后匹配者胜（同一形态下最后一条命中规则的值生效）', () => {
    const r = rules([
      ['*', 'deny'],
      ['*.env', 'allow']
    ])
    expect(matchFace(r, [['/x/.env']], (p, s) => globMatch(p, s))?.value).toBe('allow')
    const r2 = rules([
      ['*.env', 'allow'],
      ['*', 'deny']
    ])
    expect(matchFace(r2, [['/x/.env']], (p, s) => globMatch(p, s))?.value).toBe('deny')
  })
  test('多形态（原样/归一/realpath）联合判定，多条内容间取最严', () => {
    const r = rules([
      ['*', 'ask'],
      ['safe', 'allow']
    ])
    // 第一条 ask、第二条 allow → 面值 = ask（最严）
    expect(matchFace(r, [['/a/safe'], ['/b/other']], (p, s) => globMatch(p, s))?.value).toBe('ask')
  })
  test('无命中 → undefined（面对决策中性）', () => {
    expect(matchFace(rules([['a', 'allow']]), [['b']], (p, s) => globMatch(p, s))).toBeUndefined()
  })
  test('strictest：deny > ask > classify > allow', () => {
    expect(strictest(['allow', 'classify', 'ask', 'deny'])).toBe('deny')
    expect(strictest(['allow', 'classify'])).toBe('classify')
    expect(strictest(['allow'])).toBe('allow')
    expect(strictest([])).toBeUndefined()
  })
})
