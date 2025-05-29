import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FlatCompat } from '@eslint/eslintrc'
import eslintPluginJs from '@eslint/js'
import eslintPluginStylistic from '@stylistic/eslint-plugin'
import eslintPluginMocha from 'eslint-plugin-mocha'
import eslintPluginN from 'eslint-plugin-n'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import globals from 'globals'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({ baseDirectory: __dirname })

const SRC_FILES = [
  '*.js',
  '*.mjs',
  'ext/**/*.js',
  'ext/**/*.mjs',
  'packages/*/src/**/*.js',
  'packages/*/src/**/*.mjs'
]

const TEST_FILES = [
  'packages/*/test/**/*.js',
  'packages/*/test/**/*.mjs',
  'integration-tests/**/*.js',
  'integration-tests/**/*.mjs',
  '**/*.spec.js'
]

export default [
  {
    name: 'dd-trace/global-ignore',
    ignores: [
      '**/coverage', // Just coverage reports.
      '**/dist', // Generated
      '**/docs', // Any JS here is for presentation only.
      '**/out', // Generated
      '**/node_modules', // We don't own these.
      '**/versions', // This is effectively a node_modules tree.
      '**/acmeair-nodejs', // We don't own this.
      '**/vendor', // Generally, we didn't author this code.
      'integration-tests/debugger/target-app/source-map-support/minify.min.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/typescript.js', // Generated
      'integration-tests/esbuild/out.js', // Generated
      'integration-tests/esbuild/aws-sdk-out.js', // Generated
      'packages/dd-trace/src/payload-tagging/jsonpath-plus.js', // Vendored
      'packages/dd-trace/src/guardrails/**/*' // Guardrails contain very old JS
    ]
  },
  { name: '@eslint/js/recommended', ...eslintPluginJs.configs.recommended },
  ...compat.extends('standard').map((config, i) => ({ name: config.name || `standard/${i + 1}`, ...config })),
  {
    name: 'dd-trace/defaults',

    plugins: {
      '@stylistic': eslintPluginStylistic,
      n: eslintPluginN,
      unicorn: eslintPluginUnicorn
    },

    languageOptions: {
      globals: {
        ...globals.node
      },

      ecmaVersion: 2022
    },

    settings: {
      node: {
        // Used by `eslint-plugin-n` to determine the minimum version of Node.js to support.
        // Normally setting this in the `package.json` engines field is enough, but when we have more than one active
        // major release line at the same time, we need to specify the lowest version here to ensure backporting will
        // not fail.
        version: '>=18.0.0'
      }
    },

    rules: {
      '@stylistic/max-len': ['error', { code: 120, tabWidth: 2, ignoreUrls: true }],
      '@stylistic/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      'import/no-extraneous-dependencies': 'error',
      'n/no-restricted-require': ['error', ['diagnostics_channel']],
      'no-console': 'error',
      'no-prototype-builtins': 'off', // Override (turned on by @eslint/js/recommnded)
      'no-unused-expressions': 'off', // Override (turned on by standard)
      'no-var': 'error', // Override (set to warn in standard)
      'require-await': 'error'
    }
  },
  {
    name: 'dd-trace/src/all',
    files: SRC_FILES,
    rules: {
      'n/no-restricted-require': ['error', [
        {
          name: 'diagnostics_channel',
          message: 'Please use dc-polyfill instead.'
        },
        {
          name: 'semver',
          message: 'Please use semifies instead.'
        }
      ]],

      ...eslintPluginUnicorn.configs.recommended.rules,

      // Overriding recommended unicorn rules
      'unicorn/catch-error-name': ['off', { name: 'err' }], // 166 errors
      'unicorn/consistent-function-scoping': 'off', // 21 errors
      'unicorn/expiring-todo-comments': 'off',
      'unicorn/explicit-length-check': 'off', // 68 errors
      'unicorn/filename-case': ['off', { case: 'kebabCase' }], // 59 errors
      'unicorn/import-style': 'off', // 9 errors - controversial
      'unicorn/no-anonymous-default-export': 'off', // only makes a difference for ESM
      'unicorn/no-array-callback-reference': 'off', // too strict
      'unicorn/no-array-for-each': 'off', // 122 errors
      'unicorn/no-array-reduce': 'off', // too strict
      'unicorn/no-for-loop': 'off', // 15 errors
      'unicorn/no-hex-escape': 'off', // too strict
      'unicorn/no-lonely-if': 'off', // 19 errors
      'unicorn/no-negated-condition': 'off', // too strict
      'unicorn/no-nested-ternary': 'off', // too strict
      'unicorn/no-new-array': 'off', // 6 errors
      'unicorn/no-null': 'off', // too strict
      'unicorn/no-object-as-default-parameter': 'off', // too strict
      'unicorn/no-this-assignment': 'off', // too strict
      'unicorn/no-unreadable-array-destructuring': 'off', // TODO: undecided
      'unicorn/no-unreadable-iife': 'off', // too strict
      'unicorn/numeric-separators-style': 'off', // 35 errors
      'unicorn/prefer-array-flat': 'off', // 9 errors
      'unicorn/prefer-at': 'off', // 47 errors
      'unicorn/prefer-code-point': 'off', // 3 errors
      'unicorn/prefer-event-target': 'off', // TODO: undecided (2 errors)
      'unicorn/prefer-global-this': 'off', // 23 errors
      'unicorn/prefer-includes': 'off', // 19 errors
      'unicorn/prefer-logical-operator-over-ternary': 'off', // 15 errors
      'unicorn/prefer-math-trunc': 'off', // 8 errors
      'unicorn/prefer-module': 'off', // too strict
      'unicorn/prefer-native-coercion-functions': 'off', // 18 errors
      'unicorn/prefer-node-protocol': 'off', // 148 errors
      'unicorn/prefer-number-properties': 'off', // 56 errors
      'unicorn/prefer-object-from-entries': 'off', // 3 errors
      'unicorn/prefer-optional-catch-binding': 'off', // 62 errors
      'unicorn/prefer-reflect-apply': 'off', // too strict
      'unicorn/prefer-set-has': 'off', // 18 errors
      'unicorn/prefer-spread': 'off', // 36 errors
      'unicorn/prefer-string-raw': 'off', // 22 errors
      'unicorn/prefer-string-replace-all': 'off', // 33 errors
      'unicorn/prefer-string-slice': 'off', // 53 errors
      'unicorn/prefer-switch': 'off', // 8 errors
      'unicorn/prefer-ternary': 'off', // 48 errors
      'unicorn/prefer-top-level-await': 'off', // too strict
      'unicorn/prevent-abbreviations': 'off', // too strict
      'unicorn/switch-case-braces': 'off' // too strict
    }
  },
  {
    name: 'mocha/recommended',
    ...eslintPluginMocha.configs.flat.recommended,
    files: TEST_FILES
  },
  {
    name: 'dd-trace/tests/all',
    files: TEST_FILES,
    languageOptions: {
      globals: {
        sinon: 'readonly',
        expect: 'readonly',
        proxyquire: 'readonly',
        withVersions: 'readonly',
        withPeerService: 'readonly',
        withNamingSchema: 'readonly',
        withExports: 'readonly'
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
      'require-await': 'off'
    }
  },
  {
    name: 'dd-trace/tests/integration',
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
