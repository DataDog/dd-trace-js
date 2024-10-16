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
      '**/coverage', // Just coverage reports.
      '**/dist', // Generated
      '**/docs', // Any JS here is for presentation only.
      '**/out', // Generated
      '**/node_modules', // We don't own these.
      '**/versions', // This is effectively a node_modules tree.
      '**/acmeair-nodejs', // We don't own this.
      '**/vendor', // Generally, we didn't author this code.
      'integration-tests/esbuild/out.js', // Generated
      'integration-tests/esbuild/aws-sdk-out.js', // Generated
      'packages/dd-trace/src/appsec/blocked_templates.js' // TODO Why is this ignored?
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
      '@stylistic/js/object-curly-newline': ['error', {
        multiline: true,
        consistent: true
      }],
      '@stylistic/js/object-curly-spacing': ['error', 'always'],
      'import/no-absolute-path': 'off',
      'import/no-extraneous-dependencies': 'error',
      'n/no-callback-literal': 'off',
      'n/no-restricted-require': ['error', ['diagnostics_channel']],
      'no-console': 'error',
      'no-prototype-builtins': 'off',
      'no-unused-expressions': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      'standard/no-callback-literal': 'off'
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
      'mocha/max-top-level-suites': 'off',
      'mocha/no-exports': 'off',
      'mocha/no-global-tests': 'off',
      'mocha/no-identical-title': 'off',
      'mocha/no-mocha-arrows': 'off',
      'mocha/no-setup-in-describe': 'off',
      'mocha/no-sibling-hooks': 'off',
      'mocha/no-skipped-tests': 'off',
      'mocha/no-top-level-hooks': 'off',
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
