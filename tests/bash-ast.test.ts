import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { parseCommand } from '../src/bash-ast'

/**
 * bash 命令解析（tree-sitter AST）测试。
 * 语义说明：段 = 每个 command 节点的文本（剥去行首 VAR=… 赋值），
 * 嵌套命令替换/子 shell/控制流内层命令各自成段（比旧的整块匹配更保守）。
 */
const cwd = mkdtempSync(join(tmpdir(), 'pn-bash-'))
writeFileSync(join(cwd, 'id_rsa'), 'x')
writeFileSync(join(cwd, 'SPEC.md'), 'x')

const seg = async (cmd: string) => (await parseCommand(cmd, cwd)).segments
const toks = async (cmd: string) => (await parseCommand(cmd, cwd)).pathTokens
const ask = async (cmd: string) => (await parseCommand(cmd, cwd)).askSegments

describe('分段（§7）', () => {
  test('顶层 &&/||/;/| 拆分', async () => {
    expect(await seg('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  test('引号内不拆', async () => {
    expect(await seg('echo "a && b ; c"')).toEqual(['echo "a && b ; c"'])
    expect(await seg("echo 'x | y'")).toEqual(["echo 'x | y'"])
  })
  test('命令替换/反引号/子 shell 内层命令也成段', async () => {
    expect(await seg('echo $(rm -rf x)')).toEqual(['echo $(rm -rf x)', 'rm -rf x'])
    expect((await seg('echo `rm -rf y` | cat')).sort()).toEqual(
      ['echo `rm -rf y`', 'rm -rf y', 'cat'].sort()
    )
    expect(await seg('(rm -rf z)')).toEqual(['rm -rf z'])
  })
  test('VAR=x 赋值前缀剥离后再匹配', async () => {
    expect(await seg('VAR=x rm -rf x')).toEqual(['rm -rf x'])
    expect(await seg('A=1 B="2 3" rm -rf x')).toEqual(['rm -rf x'])
  })
  test('进程替换内层成段', async () => {
    expect(await seg('diff <(a) <(b)')).toEqual(['diff <(a) <(b)', 'a', 'b'])
  })
  test('花括号组合体：段就是内层命令（不带 { 前缀）', async () => {
    expect(await seg('{ rm -rf /tmp/b; }')).toEqual(['rm -rf /tmp/b'])
    expect(await seg('mkdir a && { rm -rf /tmp/b; }')).toEqual(['mkdir a', 'rm -rf /tmp/b'])
  })
  test('控制流内层命令也成段（比旧实现更保守，deny 规则能命中内层）', async () => {
    expect(await seg('if true; then rm -rf x; fi')).toContain('rm -rf x')
    expect(await seg('for f in a.txt; do rm -rf "$f"; done')).toContain('rm -rf "$f"')
  })
  test('插值 heredoc 体内命令成段；引号限定符是字面数据不评估', async () => {
    expect(await seg('cat << EOF\nrm -rf x\nEOF\n')).toContain('rm -rf x')
    expect(await seg("cat << 'EOF'\nrm -rf x\nEOF\n")).not.toContain('rm -rf x')
  })
})

describe('路径候选（§5）', () => {
  test('重定向目标进候选；段文本不含重定向', async () => {
    expect(await seg('echo hi > /etc/x.conf')).toEqual(['echo hi'])
    expect(await toks('echo hi > /etc/x.conf')).toContain('/etc/x.conf')
  })
  test('sed 的内联正则不再被当成路径（本例回归）', async () => {
    const regex = String.fromCharCode(47) + '^## 6. classify' + String.fromCharCode(47)
    const t = await toks('sed -n ' + "'" + regex + ",' " + 'SPEC.md')
    expect(t).not.toContain(regex)
    expect(t.some((x) => x.includes('^##'))).toBe(false)
    expect(t).toContain('SPEC.md')
  })
  test('grep 的内联模式跳过，模式后的文件照常收集', async () => {
    expect(await toks("grep -n 'foo.*bar' SPEC.md")).toEqual(['SPEC.md'])
    // 选项带值：-m 的值不是模式，下一个位置参数才是
    expect(await toks('grep -m 3 foo SPEC.md')).toEqual(['SPEC.md'])
  })
  test('裸词靠存在性探测：存在才算候选', async () => {
    expect(await toks('cat id_rsa')).toContain('id_rsa')
    expect(await toks('cat nope_not_here')).not.toContain('nope_not_here')
  })
  test('赋值、URL、@scope 不算路径', async () => {
    expect(await toks('FOO=/bar cmd')).not.toContain('/bar')
    expect(await toks('curl https://x/y/z')).not.toContain('https://x/y/z')
    expect(await toks('npm i @scope/pkg')).not.toContain('@scope/pkg')
  })
})

describe('未展开变量（宁可多问）', () => {
  test("$VAR / ${…} / 位置参数进 askSegments；$() $((…)) $'…' 不进", async () => {
    expect(await ask('cat $HOME/x.env')).toEqual(['cat $HOME/x.env'])
    expect(await ask('cat ${VAR}/x')).toEqual(['cat ${VAR}/x'])
    expect(await ask('x $1 y')).toEqual(['x $1 y'])
    expect(await ask("echo $'abc'")).toEqual([])
    expect(await ask('echo $((1+2))')).toEqual([])
    expect(await ask('echo $(cmd)')).toEqual([])
  })
})

describe('解析器状态', () => {
  test('正常解析时 degraded=false', async () => {
    expect((await parseCommand('git status', cwd)).degraded).toBe(false)
  })
})
