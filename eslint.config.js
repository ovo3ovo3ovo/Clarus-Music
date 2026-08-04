import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'src-tauri/target/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Audio: 'readonly',
        Blob: 'readonly',
        DOMException: 'readonly',
        Event: 'readonly',
        HTMLAudioElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLMediaElement: 'readonly',
        MediaError: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        cancelAnimationFrame: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        requestAnimationFrame: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'vue/block-order': ['error', { order: ['template', 'script', 'style'] }],
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
      'vue/multi-word-component-names': 'off',
    },
  },
  prettier,
)
