# pi-permission

独立的 pi 权限管理扩展。

覆盖 4 个面（工具名 / `path` / `bash` / `external_directory`）× 4 种值
（`allow` / `ask` / `deny` / `classify`）；`classify` 通过 pi 的
`ctx.modelRegistry.classify()` 判定放行或拒绝。

## 目录

```text
src/                扩展入口与后续模块
tests/              测试
eslint.config.mjs   ESLint flat config
```

## 加载

package.json 中已声明 `pi` 清单（`extensions: ["./src"]`），本地路径安装即可长期全局加载：

```bash
pi install /path/to/pi-permission
```

临时试用（仅当前进程，不写 settings）：

```bash
pi -e /path/to/pi-permission
```

## 命令

```bash
pnpm check    # tsc --noEmit && eslint
pnpm test     # vitest run
pnpm format   # prettier --write
```
