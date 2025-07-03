import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FlatCompat } from '@eslint/eslintrc'
import eslintPluginJs from '@eslint/js'
import eslintPluginStylistic from '@stylistic/eslint-plugin'
import eslintPluginMocha from 'eslint-plugin-mocha'
import eslintPluginN from 'eslint-plugin-n'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import globals from 'globals'

import eslintProcessEnv from './eslint-rules/eslint-process-env.mjs'
import eslintEnvAliases from './eslint-rules/eslint-env-aliases.mjs'
import eslintSafeTypeOfObject from './eslint-rules/eslint-safe-typeof-object.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({ baseDirectory: __dirname })

const SRC_FILES = [
  '*.js',
  '*.mjs',
  'ext/**/*.js',
  'ext/**/*.mjs',
  'ci/**/*.js',
  'ci/**/*.mjs',
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
      'integration-tests/debugger/target-app/source-map-support/bundle.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/hello/world.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/minify.min.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/typescript.js', // Generated
      'integration-tests/esbuild/out.js', // Generated
      'integration-tests/esbuild/aws-sdk-out.js', // Generated
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
      '@stylistic/max-len': ['error', { code: 120, tabWidth: 2, ignoreUrls: true, ignoreRegExpLiterals: true }],
      '@stylistic/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/comma-dangle': ['error', {
        arrays: 'only-multiline',
        objects: 'only-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'only-multiline',
        importAttributes: 'always-multiline',
        dynamicImports: 'always-multiline'
      }],
      'comma-dangle': 'off', // Override (turned on by @eslint/js/recommended)
      'import/no-extraneous-dependencies': 'error',
      'n/no-restricted-require': ['error', ['diagnostics_channel']],
      'no-console': 'error',
      'no-mixed-operators': 'off', // Override (turned on by standard)
      'no-prototype-builtins': 'off', // Override (turned on by @eslint/js/recommended)
      'no-unused-expressions': 'off', // Override (turned on by standard)
      'no-var': 'error', // Override (set to warn in standard)
      'require-await': 'error'
    }
  },
  {
    name: 'dd-trace/src/all',
    files: SRC_FILES,
    plugins: {
      'eslint-rules': {
        rules: {
          'eslint-process-env': eslintProcessEnv,
          'eslint-env-aliases': eslintEnvAliases,
          'eslint-safe-typeof-object': eslintSafeTypeOfObject
        }
      }
    },
    rules: {
      'eslint-rules/eslint-process-env': 'error',
      'eslint-rules/eslint-env-aliases': 'error',
      'eslint-rules/eslint-safe-typeof-object': 'error',
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

      'no-await-in-loop': 'error',
      'no-else-return': ['error', { allowElseIf: true }],
      'no-implicit-coercion': ['error', { boolean: true, number: true, string: true, allow: ['!!'] }],
      'no-useless-assignment': 'error',
      'operator-assignment': 'error',
      'prefer-exponentiation-operator': 'error',
      'prefer-object-has-own': 'error',
      'prefer-object-spread': 'error',

      // Too strict for now. Slowly migrate to this rule by using rest parameters.
      // 'prefer-rest-params': 'error',

      ...eslintPluginUnicorn.configs.recommended.rules,

      // Overriding recommended unicorn rules
      'unicorn/catch-error-name': ['off', { name: 'err' }], // 166 errors
      'unicorn/expiring-todo-comments': 'off',
      'unicorn/explicit-length-check': 'off', // 68 errors
      'unicorn/filename-case': ['off', { case: 'kebabCase' }], // 59 errors
      'unicorn/no-array-for-each': 'off', // 122 errors
      'unicorn/prefer-at': 'off', // 17 errors | Difficult to fix
      'unicorn/prevent-abbreviations': 'off', // too strict

      // These rules could potentially evaluated again at a much later point
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-for-loop': 'off', // Activate if this is resolved https://github.com/sindresorhus/eslint-plugin-unicorn/issues/2664
      'unicorn/no-nested-ternary': 'off', // Not really an issue in the code and the benefit is small
      'unicorn/no-this-assignment': 'off', // This would need some further refactoring and the benefit is small
      'unicorn/prefer-code-point': 'off', // Should be activated, but needs a refactor of some code

      // The following rules should not be activated!
      'unicorn/import-style': 'off', // Questionable benefit
      'unicorn/no-array-reduce': 'off', // Questionable benefit
      'unicorn/no-hex-escape': 'off', // Questionable benefit
      'unicorn/no-new-array': 'off', // new Array is often used for performance reasons
      'unicorn/no-null': 'off', // We do not control external APIs and it is hard to differentiate these
      'unicorn/prefer-event-target': 'off', // Benefit only outside of Node.js
      'unicorn/prefer-global-this': 'off', // Questionable benefit in Node.js alone
      'unicorn/prefer-math-trunc': 'off', // Math.trunc is not a 1-to-1 replacement for most of our usage
      'unicorn/prefer-module': 'off', // We use CJS
      'unicorn/prefer-node-protocol': 'off', // May not be used due to guardrails
      'unicorn/prefer-reflect-apply': 'off', // Questionable benefit and more than 500 matches
      'unicorn/prefer-switch': 'off', // Questionable benefit
      'unicorn/prefer-top-level-await': 'off', // Only useful when using ESM
      'unicorn/switch-case-braces': 'off', // Questionable benefit
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
