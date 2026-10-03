import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * pi-permission 扩展入口。
 *
 * 当前仅为工程化外壳：不注册任何能力，只用于验证扩展可被 pi 加载、
 * 类型可检查、测试可运行。权限判定逻辑见 SPEC.md，尚未接入。
 */
export default function piPermission(_pi: ExtensionAPI): void {
  // 占位：后续在此注册 tool_call 门禁、被禁工具隐藏与配置加载。
}
