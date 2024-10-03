import mocha from 'eslint-plugin-mocha'
import n from 'eslint-plugin-n'
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
      n
    },

    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
        sinon: false,
        expect: false,
        proxyquire: false,
        withVersions: false,
        withPeerService: false,
        withNamingSchema: false,
        withExports: false
      },

      ecmaVersion: 2022
    },

    settings: {
      node: {
        version: '>=16.0.0'
      }
    },

    rules: {
      'max-len': [2, 120, 2],
      'no-var': 2,
      'no-console': 2,
      'prefer-const': 2,
      'object-curly-spacing': [2, 'always'],
      'import/no-extraneous-dependencies': 2,
      'standard/no-callback-literal': 0,
      'no-prototype-builtins': 0,
      'n/no-restricted-require': [2, ['diagnostics_channel']],
      'n/no-callback-literal': 0,

      'object-curly-newline': ['error', {
        multiline: true,
        consistent: true
      }],

      'import/no-absolute-path': 0,
      'no-unused-expressions': 0
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
      'mocha/no-mocha-arrows': 0,
      'mocha/no-setup-in-describe': 0,
      'mocha/no-sibling-hooks': 0,
      'mocha/no-top-level-hooks': 0,
      'mocha/max-top-level-suites': 0,
      'mocha/no-identical-title': 0,
      'mocha/no-global-tests': 0,
      'mocha/no-exports': 0,
      'mocha/no-skipped-tests': 0,
      'n/handle-callback-err': 0,
      'no-loss-of-precision': 0
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
      'import/no-extraneous-dependencies': 0
    }
  }
]
