import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FlatCompat } from '@eslint/eslintrc'
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin-js'
import mocha from 'eslint-plugin-mocha'
import n from 'eslint-plugin-n'
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
      'packages/dd-trace/src/payload-tagging/jsonpath-plus.js' // Vendored
    ]
  },
  { name: '@eslint/js/recommnded', ...js.configs.recommended },
  ...compat.extends('standard').map((config, i) => ({ name: config.name || `standard/${i + 1}`, ...config })),
  {
    name: 'dd-trace/defaults',

    plugins: {
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
      ]]
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
