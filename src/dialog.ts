import { Container, getKeybindings, Spacer, Text } from '@earendil-works/pi-tui'

/**
 * 权限确认弹窗——忠实复刻 pi 内置 ExtensionSelectorComponent（native ui.select
 * 弹窗）的结构与样式：accent+bold 标题、正文槽位（text 色）、`→ ` 选中标记、
 * ↑↓/j/k 与 Enter/Esc 键位、底部键位提示行。
 *
 * 与 native 的唯一差异：
 * 1. 去掉上、下两条 DynamicBorder 横线（用户要求）
 * 2. 正文槽位显示要执行的命令原文 / 操作路径（用户要求：提示执行的命令）
 *
 * 不做任何额外发挥。
 */

export const ASK_OPTIONS = ['允许', '本会话都允许', '拒绝'] as const

export type AskChoice = 'allow' | 'session' | 'deny'

/** 选项下标 → 决策值（与 ASK_OPTIONS 顺序一致） */
const CHOICES: AskChoice[] = ['allow', 'session', 'deny']

/** 弹窗内容：标题（含要执行的命令/操作路径） */
export interface AskPayload {
  title: string
  /** 要执行的命令原文（bash 类工具）或操作路径（文件类工具）；缺省不显示 */
  content?: string
}

/** 从 pi theme 提取的样式面；gate 调用处用 theme.fg/bold 包装传入 */
export interface DialogTheme {
  fg(color: string, text: string): string
  bold(text: string): string
}

/** 键位动作名（取自 pi-tui KeybindingsManager.getKeys 的形参类型，避免字符串拓宽报错） */
type BindingName = Parameters<ReturnType<typeof getKeybindings>['getKeys']>[0]

/** 复刻 native keyHint 格式：dim 键名 + muted 描述（键名来自可配置键位） */
function keyHint(themeLike: DialogTheme, binding: BindingName, description: string): string {
  const keys = getKeybindings().getKeys(binding).join('/')
  return themeLike.fg('dim', keys) + themeLike.fg('muted', ` ${description}`)
}

/**
 * 弹窗组件：结构与 native ExtensionSelectorComponent 一致，
 * 仅去掉上下两条 DynamicBorder。
 */
export class AskDialogComponent extends Container {
  private options = [...ASK_OPTIONS]
  private selectedIndex = 0
  private listContainer = new Container()
  private payload: AskPayload
  private themeLike: DialogTheme
  private onSelect: (choice: AskChoice) => void
  private onCancel: () => void

  constructor(
    payload: AskPayload,
    themeLike: DialogTheme,
    onSelect: (choice: AskChoice) => void,
    onCancel: () => void
  ) {
    super()
    this.payload = payload
    this.themeLike = themeLike
    this.onSelect = onSelect
    this.onCancel = onCancel

    // ── 与 native 相同的结构（去掉顶部 DynamicBorder） ──
    this.addChild(new Spacer(1))
    // 标题：工具名 · 完整命令/操作路径（用户要求的格式：工具+点+其他，不另起一行）；
    // 无命令时仅显示工具名
    const headline = payload.content ? `${payload.title} · ${payload.content}` : payload.title
    this.addChild(new Text(themeLike.fg('accent', themeLike.bold(headline)), 1, 0))
    this.addChild(new Spacer(1))
    this.addChild(this.listContainer)
    this.addChild(new Spacer(1))
    // 键位提示行（复刻 native 的 rawKeyHint/keyHint 组合）
    this.addChild(
      new Text(
        themeLike.fg('dim', '↑↓') +
          themeLike.fg('muted', ' navigate') +
          '  ' +
          keyHint(themeLike, 'tui.select.confirm', 'select') +
          '  ' +
          keyHint(themeLike, 'tui.select.cancel', 'cancel'),
        1,
        0
      )
    )
    this.addChild(new Spacer(1))
    // 无底部 DynamicBorder（native 此处有下横线）
    this.updateList()
  }

  /** 与 native updateList 相同的选中样式：→ + accent */
  private updateList(): void {
    this.listContainer.clear()
    for (let i = 0; i < this.options.length; i++) {
      const isSelected = i === this.selectedIndex
      const option = this.options[i]
      if (option === undefined) continue // noUncheckedIndexedAccess：越界防御
      const text = isSelected
        ? this.themeLike.fg('accent', '→ ') + this.themeLike.fg('accent', option)
        : `  ${this.themeLike.fg('text', option)}`
      this.listContainer.addChild(new Text(text, 1, 0))
    }
  }

  /** 与 native 相同的键位处理（上/下夹紧不循环；j/k 近道；Enter 确认；cancel 取消） */
  handleInput(keyData: string): void {
    const kb = getKeybindings()
    if (kb.matches(keyData, 'tui.select.up') || keyData === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1)
      this.updateList()
    } else if (kb.matches(keyData, 'tui.select.down') || keyData === 'j') {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1)
      this.updateList()
    } else if (kb.matches(keyData, 'tui.select.confirm') || keyData === '\n') {
      const choice = CHOICES[this.selectedIndex]
      if (choice) this.onSelect(choice)
    } else if (kb.matches(keyData, 'tui.select.cancel')) {
      this.onCancel()
    }
  }
}
