import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FlatCompat } from '@eslint/eslintrc'
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin-js'
import mocha from 'eslint-plugin-mocha'
import n from 'eslint-plugin-n'
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
      'packages/dd-trace/src/appsec/blocked_templates.js', // TODO Why is this ignored?
      'packages/dd-trace/src/payload-tagging/jsonpath-plus.js' // Vendored
    ]
  },
  { name: '@eslint/js/recommnded', ...js.configs.recommended },
  ...compat.extends('standard').map((config, i) => ({ name: config.name || `standard/${i + 1}`, ...config })),
  {
    name: 'dd-trace/defaults',

    plugins: {
      '@stylistic/js': stylistic,
      n,
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
      '@stylistic/js/max-len': ['error', { code: 120, tabWidth: 2 }],
      '@stylistic/js/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/js/object-curly-spacing': ['error', 'always'],
      'import/no-extraneous-dependencies': 'error',
      'n/no-restricted-require': ['error', ['diagnostics_channel']],
      'no-console': 'error',
      'no-prototype-builtins': 'off', // Override (turned on by @eslint/js/recommnded)
      'no-unused-expressions': 'off', // Override (turned on by standard)
      'no-var': 'error' // Override (set to warn in standard)
    }
  },
  {
    name: 'mocha/recommnded',
    ...mocha.configs.flat.recommended,
    files: TEST_FILES
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
      'unicorn/better-regex': 'off',
      'unicorn/catch-error-name': ['error', { name: 'err' }], // 166 errors
      'unicorn/consistent-destructuring': 'off',
      'unicorn/consistent-empty-array-spread': 'error', // 0 errors
      'unicorn/consistent-existence-index-check': 'error', // 4 errors
      'unicorn/consistent-function-scoping': 'error', // 21 errors
      'unicorn/custom-error-definition': 'error', // 3 errors
      'unicorn/empty-brace-spaces': 'error', // 15 errors
      'unicorn/error-message': 'error', // 1 error
      'unicorn/escape-case': 'error', // 8 errors
      'unicorn/expiring-todo-comments': 'off',
      'unicorn/explicit-length-check': 'error', // 68 errors
      'unicorn/filename-case': ['error', { case: 'kebabCase' }], // 59 errors
      'unicorn/import-style': 'off',
      'unicorn/new-for-builtins': 'error', // 5 errors
      'unicorn/no-abusive-eslint-disable': 'error', // 10 errors
      'unicorn/no-anonymous-default-export': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-array-for-each': 'error', // 122 errors
      'unicorn/no-array-method-this-argument': 'error', // 0 errors
      'unicorn/no-array-push-push': 'error', // 6 errors
      'unicorn/no-array-reduce': 'off',
      'unicorn/no-await-expression-member': 'error', // 0 errors
      'unicorn/no-await-in-promise-methods': 'error', // 0 errors
      'unicorn/no-console-spaces': 'off',
      'unicorn/no-document-cookie': 'off',
      'unicorn/no-empty-file': 'error', // 0 errors
      'unicorn/no-for-loop': 'error', // 15 errors
      'unicorn/no-hex-escape': 'off',
      'unicorn/no-instanceof-array': 'error', // 5 errors
      'unicorn/no-invalid-fetch-options': 'error', // 0 errors
      'unicorn/no-invalid-remove-event-listener': 'error', // 0 errors
      'unicorn/no-keyword-prefix': 'off',
      'unicorn/no-length-as-slice-end': 'error', // 0 errors
      'unicorn/no-lonely-if': 'error', // 19 errors
      'unicorn/no-magic-array-flat-depth': 'error', // 0 errors
      'unicorn/no-negated-condition': 'off',
      'unicorn/no-negation-in-equality-check': 'error', // 0 errors
      'unicorn/no-nested-ternary': 'off',
      'unicorn/no-new-array': 'off',
      'unicorn/no-new-buffer': 'error', // 0 errors
      'unicorn/no-null': 'off',
      'unicorn/no-object-as-default-parameter': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/no-single-promise-in-promise-methods': 'error', // 0 errors
      'unicorn/no-static-only-class': 'off',
      'unicorn/no-thenable': 'off',
      'unicorn/no-this-assignment': 'off',
      'unicorn/no-typeof-undefined': 'error', // 1 error
      'unicorn/no-unnecessary-await': 'error', // 0 errors
      'unicorn/no-unnecessary-polyfills': 'error', // 0 errors
      'unicorn/no-unreadable-array-destructuring': 'off',
      'unicorn/no-unreadable-iife': 'off',
      'unicorn/no-unused-properties': 'off',
      'unicorn/no-useless-fallback-in-spread': 'error', // 0 errors
      'unicorn/no-useless-length-check': 'error', // 0 errors
      'unicorn/no-useless-promise-resolve-reject': 'error', // 3 errors
      'unicorn/no-useless-spread': 'error', // 0 errors
      'unicorn/no-useless-switch-case': 'error', // 0 errors
      'unicorn/no-useless-undefined': 'error', // 59 errors
      'unicorn/no-zero-fractions': 'error', // 5 errors
      'unicorn/number-literal-case': 'error', // 44 errors
      'unicorn/numeric-separators-style': 'error', // 35 errors
      'unicorn/prefer-add-event-listener': 'off',
      'unicorn/prefer-array-find': 'error', // 0 errors
      'unicorn/prefer-array-flat-map': 'error', // 1 error
      'unicorn/prefer-array-flat': 'error', // 9 errors
      'unicorn/prefer-array-index-of': 'error', // 0 errors
      'unicorn/prefer-array-some': 'error', // 2 errors
      'unicorn/prefer-at': 'error', // 47 errors
      'unicorn/prefer-blob-reading-methods': 'off',
      'unicorn/prefer-code-point': 'error', // 3 errors
      'unicorn/prefer-date-now': 'error', // 0 errors
      'unicorn/prefer-default-parameters': 'error', // 1 error
      'unicorn/prefer-dom-node-append': 'off',
      'unicorn/prefer-dom-node-dataset': 'off',
      'unicorn/prefer-dom-node-remove': 'off',
      'unicorn/prefer-dom-node-text-content': 'off',
      'unicorn/prefer-event-target': 'off',
      'unicorn/prefer-export-from': 'off',
      'unicorn/prefer-global-this': 'error', // 23 errors
      'unicorn/prefer-includes': 'error', // 19 errors
      'unicorn/prefer-json-parse-buffer': 'off',
      'unicorn/prefer-keyboard-event-key': 'off',
      'unicorn/prefer-logical-operator-over-ternary': 'error', // 15 errors
      'unicorn/prefer-math-min-max': 'error', // 1 error
      'unicorn/prefer-math-trunc': 'error', // 8 errors
      'unicorn/prefer-modern-dom-apis': 'off',
      'unicorn/prefer-modern-math-apis': 'error', // 0 errors
      'unicorn/prefer-module': 'off',
      'unicorn/prefer-native-coercion-functions': 'error', // 18 errors
      'unicorn/prefer-negative-index': 'error', // 1 error
      'unicorn/prefer-node-protocol': 'error', // 148 errors
      'unicorn/prefer-number-properties': 'error', // 56 errors
      'unicorn/prefer-object-from-entries': 'error', // 3 errors
      'unicorn/prefer-optional-catch-binding': 'error', // 62 errors
      'unicorn/prefer-prototype-methods': 'error', // 0 errors
      'unicorn/prefer-query-selector': 'off',
      'unicorn/prefer-reflect-apply': 'error', // 520 errors
      'unicorn/prefer-regexp-test': 'error', // 6 errors
      'unicorn/prefer-set-has': 'error', // 18 errors
      'unicorn/prefer-set-size': 'error', // 0 errors
      'unicorn/prefer-spread': 'error', // 36 errors
      'unicorn/prefer-string-raw': 'error', // 22 errors
      'unicorn/prefer-string-replace-all': 'error', // 33 errors
      'unicorn/prefer-string-slice': 'error', // 53 errors
      'unicorn/prefer-string-starts-ends-with': 'error', // 0 errors
      'unicorn/prefer-string-trim-start-end': 'error', // 0 errors
      'unicorn/prefer-structured-clone': 'error', // 0 errors
      'unicorn/prefer-switch': 'error', // 8 errors
      'unicorn/prefer-ternary': 'error', // 48 errors
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/prefer-type-error': 'error', // 5 errors
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/relative-url-style': 'error', // 1 error
      'unicorn/require-array-join-separator': 'error', // 0 errors
      'unicorn/require-number-to-fixed-digits-argument': 'error', // 0 errors
      'unicorn/require-post-message-target-origin': 'off',
      'unicorn/string-content': 'off',
      'unicorn/switch-case-braces': 'off',
      'unicorn/template-indent': 'error', // 0 errors
      'unicorn/text-encoding-identifier-case': 'error', // 4 errors
      'unicorn/throw-new-error': 'error' // 5 errors
    }
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
      'n/handle-callback-err': 'off'
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
