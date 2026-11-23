import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/**
 * Flat config（ESLint 9+ / 10）。
 *
 * 策略说明：
 * - 只做「静态检查」，不做自动修复（仓库里 `lint` 脚本刻意不加 `--fix`）：
 *   存量问题先量化，再逐个评估 —— 尤其是 react-hooks/exhaustive-deps，
 *   盲目加依赖会改变运行时行为。
 * - `exhaustive-deps` 与 `rules-of-hooks` 都设为 error：这两类是最容易引发
 *   "改了依赖数组就出 bug" 的地方，必须在 CI 里挡住新增问题。
 * - 不使用 type-aware 规则（需要 parserOptions.project，跑得慢）；类型问题交给 tsc -b。
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-lib/**',
      'node_modules/**',
      '.verify/**',
      'public/**',
      'build/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // 依赖数组缺失/多余会直接改变运行时语义 —— 提到 error，逐个人工评估。
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // 存量里大量「显式 any / 非空断言」是历史写法：先降为 warn，不阻塞 CI。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 构建脚本跑在 node 里（console/process 等）：单独给 node globals
    files: ['scripts/**/*.mjs', 'tools/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // 测试与配置脚本：允许更宽松的写法
    files: ['tests/**/*.ts', 'tests/**/*.tsx', '*.config.ts', 'vite.config*.ts', 'tools/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)