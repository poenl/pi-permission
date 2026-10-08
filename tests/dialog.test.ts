import { describe, expect, test } from 'vitest'

import { ASK_OPTIONS, AskDialogComponent, type AskPayload } from '../src/dialog'

/** 恒等 theme：不带 ANSI，便于纯文本断言 */
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
}

const payload: AskPayload = {
  title: 'bash',
  content: 'rm -rf /tmp/x && echo done'
}

/** 构造弹窗并捕获 onSelect / onCancel */
function make(p: AskPayload = payload) {
  const picked: string[] = []
  let cancelled = 0
  const comp = new AskDialogComponent(
    p,
    theme,
    (choice) => {
      picked.push(choice)
    },
    () => {
      cancelled++
    }
  )
  return {
    comp,
    picked: () => picked,
    cancelled: () => cancelled
  }
}

describe('AskDialogComponent（复刻 native select，去横线）', () => {
  test('渲染包含标题、命令原文与全部选项；不显示命中详情', () => {
    const { comp } = make()
    const lines = comp.render(80)
    const text = lines.join('\n')
    expect(text).toContain('bash · rm -rf /tmp/x && echo done')
    expect(text).toContain('rm -rf /tmp/x && echo done')
    expect(text).not.toContain('工作目录外:')
    for (const label of ASK_OPTIONS) expect(text).toContain(label)
  })
  test('完整命令直接跟在标题行里，不另起一行（用户要求）', () => {
    const { comp } = make()
    const lines = comp.render(80)
    expect(lines.some((l) => l.includes('bash · rm -rf /tmp/x && echo done'))).toBe(true)
    // 不存在只含命令的独立段（命令行同时无关 title 前缀的行）
    expect(lines.filter((l) => l.includes('rm -rf /tmp/x && echo done')).length).toBe(1)
  })
  test('不绘制边框：无 DynamicBorder 的横线/边角字符', () => {
    const { comp } = make()
    for (const line of comp.render(80)) {
      expect(line).not.toMatch(/[─━│┌┐└┘├┤┬┴┼═║╔╗╚╝]/)
    }
  })
  test('选中项用 native 同款 → 标记（首项默认选中）', () => {
    const { comp } = make()
    const lines = comp.render(80)
    expect(lines.some((l) => l.includes('→ 允许'))).toBe(true)
    expect(lines.some((l) => l.includes('  本会话都允许'))).toBe(true)
  })
  test('j/k 移动、Enter 确认当前项', () => {
    const { comp, picked } = make()
    comp.handleInput('j')
    comp.handleInput('\n')
    expect(picked()).toEqual(['session'])
  })
  test('取消键触发 onCancel（done(undefined) → askUser 落 deny）', () => {
    const { comp, cancelled } = make()
    comp.handleInput('\x1b')
    expect(cancelled()).toBe(1)
  })
  test('上边界与下边界：j 到底不再下移、k 到顶不再上移', () => {
    const { comp, picked } = make()
    comp.handleInput('j')
    comp.handleInput('j')
    comp.handleInput('j') // 到底
    comp.handleInput('\n')
    expect(picked()).toEqual(['deny'])
    const c2 = make()
    c2.comp.handleInput('k') // 到顶
    c2.comp.handleInput('\n')
    expect(c2.picked()).toEqual(['allow'])
  })
  test('标题不含「权限确认」字样：无正文时只显示工具名', () => {
    const { comp } = make({ title: 'read' })
    const text = comp.render(80).join('\n')
    expect(text).not.toContain('权限确认')
    expect(text).toContain('read')
    for (const label of ASK_OPTIONS) expect(text).toContain(label)
  })
  test('默认渲染全篇均不含「权限确认」字样', () => {
    const { comp } = make()
    expect(comp.render(80).join('\n')).not.toContain('权限确认')
  })
})
