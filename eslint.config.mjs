import mocha from 'eslint-plugin-mocha'
import n from 'eslint-plugin-n'
import stylistic from '@stylistic/eslint-plugin-js'
import globals from 'globals'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all
})

export default [
  {
    ignores: [
      '**/coverage',
      '**/dist',
      '**/docs',
      '**/out',
      '**/node_modules',
      '**/versions',
      '**/acmeair-nodejs',
      '**/vendor',
      'integration-tests/esbuild/out.js',
      'integration-tests/esbuild/aws-sdk-out.js',
      'packages/dd-trace/src/appsec/blocked_templates.js'
    ]
  }, ...compat.extends('eslint:recommended', 'standard', 'plugin:mocha/recommended'), {
    plugins: {
      mocha,
      n,
      '@stylistic/js': stylistic
    },

    languageOptions: {
      globals: {
        ...globals.node
      },

      ecmaVersion: 2022
    },

    settings: {
      node: {
        version: '>=16.0.0'
      }
    },

    rules: {
      '@stylistic/js/max-len': ['error', { code: 120, tabWidth: 2 }],
      'no-var': 'error',
      'no-console': 'error',
      'prefer-const': 'error',
      'object-curly-spacing': ['error', 'always'],
      'import/no-extraneous-dependencies': 'error',
      'standard/no-callback-literal': 'off',
      'no-prototype-builtins': 'off',
      'n/no-restricted-require': ['error', ['diagnostics_channel']],
      'n/no-callback-literal': 'off',

      'object-curly-newline': ['error', {
        multiline: true,
        consistent: true
      }],

      'import/no-absolute-path': 'off',
      'no-unused-expressions': 'off'
    }
  },
  {
    files: [
      'packages/*/test/**/*.js',
      'packages/*/test/**/*.mjs',
      'integration-tests/**/*.js',
      'integration-tests/**/*.mjs',
      '**/*.spec.js'
    ],
    languageOptions: {
      globals: {
        ...globals.mocha,
        sinon: false,
        expect: false,
        proxyquire: false,
        withVersions: false,
        withPeerService: false,
        withNamingSchema: false,
        withExports: false
      }
    },
    rules: {
      'mocha/no-mocha-arrows': 'off',
      'mocha/no-setup-in-describe': 'off',
      'mocha/no-sibling-hooks': 'off',
      'mocha/no-top-level-hooks': 'off',
      'mocha/max-top-level-suites': 'off',
      'mocha/no-identical-title': 'off',
      'mocha/no-global-tests': 'off',
      'mocha/no-exports': 'off',
      'mocha/no-skipped-tests': 'off',
      'n/handle-callback-err': 'off',
      'no-loss-of-precision': 'off'
    }
  },
  {
    files: [
      'integration-tests/**/*.js',
      'integration-tests/**/*.mjs',
      'packages/*/test/integration-test/**/*.js',
      'packages/*/test/integration-test/**/*.mjs'
    ],
    rules: {
      'import/no-extraneous-dependencies': 'off'
    }
  }
]
