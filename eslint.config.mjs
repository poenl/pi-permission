// ESLint flat config。
// 只做规则检查，代码格式由 Prettier 统一负责。
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // 依赖目录不参与检查。
  { ignores: ['node_modules/**'] },
  tseslint.configs.recommended,
  {
    rules: {
      // 允许以 _ 开头的未使用形参/变量（扩展工厂的占位形参会用到）。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  // 放最后：让 eslint-config-prettier 覆盖前面与 Prettier 冲突的格式类规则。
  eslintPluginPrettierRecommended
)
