# AGENTS.md

pi 权限管理扩展：在任何 tool_call 前按规则判定 allow / ask / deny / classify，
含 bash 命令解析、classify 模型接线、审计日志、TUI 确认弹窗、事件广播。

## 项目结构

- src/engine.ts：路径归一化 + glob + bash 命令解析（parseCommand）+ 四面匹配
- src/config.ts：两层 config.json（全局扩展目录 + 项目 .pi/extensions/pi-permission-system/），
  热重载（mtime 指纹）；模式加载时归一化（~ 展开）
- src/gate.ts：tool_call 门禁主体（四面命中 → 最严合成 → ask 弹窗/审计/事件）
- src/classifier.ts：classify 模型（任意面可用；阈值/超时/缓存，异常一律落 ask）
- src/audit.ts：审计（review 默认开 / debug 开关控制）
- src/dialog.ts：确认弹窗（复刻 native select，无边框）
- src/index.ts：session_start / tool_call / mcp_servers_change 接线 + /permission 命令

## 常用命令

- pnpm check：tsc + eslint（必须全绿）
- pnpm test：vitest（必须全绿）
- pnpm format：prettier 写格式

## 配置与行为要点

- 运行时开关（enabled / debugLog / permissionReviewLog）会话级生效，改 config.json 即热重载
- 总开关 enabled=false 时扩展无任何动作；其他扩展可用
  pi.events.emit('pi-permission:set-enabled', { enabled }) 与 /permission enable|disable 切换
- 事件：pi-permission:ask（弹窗出现）、pi-permission:resolved（type 仅 allow|deny）
- 审计日志：~/.pi/agent/logs/pi-permission-{review,debug}.log
- bash 静态解析上限：未展开变量强制 ask；$VAR 本体、xargs 目标、花括号展开路径不可知
- classify：path / bash / external_directory / mcp 四面 + 工具名兜底面都支持；请求 state 给
  tool / cwd，bash 面另给完整 command，其余面给 target（路径 / server/tool / 工具名）
