import eslintPluginJs from '@eslint/js'
import eslintPluginStylistic from '@stylistic/eslint-plugin'
import eslintPluginCypress from 'eslint-plugin-cypress'
import eslintPluginImport from 'eslint-plugin-import'
import eslintPluginMocha from 'eslint-plugin-mocha'
import eslintPluginN from 'eslint-plugin-n'
import eslintPluginPromise from 'eslint-plugin-promise'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import globals from 'globals'

import eslintProcessEnv from './eslint-rules/eslint-process-env.mjs'
import eslintEnvAliases from './eslint-rules/eslint-env-aliases.mjs'
import eslintSafeTypeOfObject from './eslint-rules/eslint-safe-typeof-object.mjs'

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
      'integration-tests/code-origin/typescript.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/bundle.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/hello/world.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/minify.min.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/typescript.js', // Generated
      'integration-tests/esbuild/out.js', // Generated
      'integration-tests/esbuild/aws-sdk-out.js', // Generated
      'packages/datadog-plugin-graphql/src/tools/index.js', // Inlined from apollo-graphql
      'packages/datadog-plugin-graphql/src/tools/signature.js', // Inlined from apollo-graphql
      'packages/datadog-plugin-graphql/src/tools/transforms.js' // Inlined from apollo-graphql
    ]
  },
  { name: '@eslint/js/recommended', ...eslintPluginJs.configs.recommended },
  {
    // The following config and rules have been inlined from `eslint-config-standard` with the following modifications:
    // - Rules that were overridden elsewhere in this file have been removed.
    // - Deprecated rules have been replaced with their official replacements.
    //
    // We've inlined these to avoid having to depend on `eslint-config-standard` as:
    // 1. It's no longer maintained.
    // 2. It came with an older bundled version of `eslint-plugin-n` which conflicted with our version.
    //
    // TODO: Move these rules to dd-trace/defaults or where they otherwise belong.
    name: 'standard',
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        ...globals.es2022,
        ...globals.node,
        document: 'readonly',
        navigator: 'readonly',
        window: 'readonly'
      }
    },
    plugins: {
      '@stylistic': eslintPluginStylistic,
      import: eslintPluginImport,
      n: eslintPluginN,
      promise: eslintPluginPromise
    },
    rules: {
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/arrow-spacing': ['error', { before: true, after: true }],
      '@stylistic/block-spacing': ['error', 'always'],
      '@stylistic/comma-spacing': ['error', { before: false, after: true }],
      '@stylistic/computed-property-spacing': ['error', 'never', { enforceForClassMembers: true }],
      '@stylistic/dot-location': ['error', 'property'],
      '@stylistic/eol-last': 'error',
      '@stylistic/generator-star-spacing': ['error', { before: true, after: true }],
      '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true }],
      '@stylistic/keyword-spacing': ['error', { before: true, after: true }],
      '@stylistic/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      '@stylistic/multiline-ternary': ['error', 'always-multiline'],
      '@stylistic/new-parens': 'error',
      '@stylistic/no-extra-parens': ['error', 'functions'],
      '@stylistic/no-floating-decimal': 'error',
      '@stylistic/no-mixed-spaces-and-tabs': 'error',
      '@stylistic/no-multi-spaces': 'error',
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
      '@stylistic/no-tabs': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/no-whitespace-before-property': 'error',
      '@stylistic/operator-linebreak': [
        'error',
        'after',
        { overrides: { '?': 'before', ':': 'before', '|>': 'before' } }
      ],
      '@stylistic/padded-blocks': [
        'error',
        { blocks: 'never', switches: 'never', classes: 'never' }
      ],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/quotes': [
        'error',
        'single',
        { avoidEscape: true, allowTemplateLiterals: 'never' }
      ],
      '@stylistic/rest-spread-spacing': ['error', 'never'],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/semi-spacing': ['error', { before: false, after: true }],
      '@stylistic/space-before-blocks': ['error', 'always'],
      '@stylistic/space-before-function-paren': ['error', 'always'],
      '@stylistic/space-in-parens': ['error', 'never'],
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/space-unary-ops': ['error', { words: true, nonwords: false }],
      '@stylistic/spaced-comment': [
        'error',
        'always',
        {
          line: { markers: ['*package', '!', '/', ',', '='] },
          block: {
            balanced: true,
            markers: ['*package', '!', ',', ':', '::', 'flow-include'],
            exceptions: ['*']
          }
        }
      ],
      '@stylistic/template-curly-spacing': ['error', 'never'],
      '@stylistic/template-tag-spacing': ['error', 'never'],
      '@stylistic/wrap-iife': ['error', 'any', { functionPrototypeMethods: true }],
      '@stylistic/yield-star-spacing': ['error', 'both'],
      'accessor-pairs': ['error', { setWithoutGet: true, enforceForClassMembers: true }],
      'array-callback-return': ['error', { allowImplicit: false, checkForEach: false }],
      'brace-style': [ // TODO: Deprecated, use @stylistic/brace-style instead
        'error',
        '1tbs',
        { allowSingleLine: true }
      ],
      camelcase: [
        'error',
        {
          allow: ['^UNSAFE_'],
          properties: 'never',
          ignoreGlobals: true
        }
      ],
      'comma-style': ['error', 'last'], // TODO: Deprecated, use @stylistic/comma-style instead
      curly: ['error', 'multi-line'],
      'default-case-last': 'error',
      'dot-notation': ['error', { allowKeywords: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'func-call-spacing': ['error', 'never'], // TODO: Deprecated, use @stylistic/func-call-spacing instead
      indent: [ // TODO: Deprecated, use @stylistic/indent instead
        'error',
        2,
        {
          SwitchCase: 1,
          VariableDeclarator: 1,
          outerIIFEBody: 1,
          MemberExpression: 1,
          FunctionDeclaration: { parameters: 1, body: 1 },
          FunctionExpression: { parameters: 1, body: 1 },
          CallExpression: { arguments: 1 },
          ArrayExpression: 1,
          ObjectExpression: 1,
          ImportDeclaration: 1,
          flatTernaryExpressions: false,
          ignoreComments: false,
          ignoredNodes: [
            'TemplateLiteral *',
            'JSXElement',
            'JSXElement > *',
            'JSXAttribute',
            'JSXIdentifier',
            'JSXNamespacedName',
            'JSXMemberExpression',
            'JSXSpreadAttribute',
            'JSXExpressionContainer',
            'JSXOpeningElement',
            'JSXClosingElement',
            'JSXFragment',
            'JSXOpeningFragment',
            'JSXClosingFragment',
            'JSXText',
            'JSXEmptyExpression',
            'JSXSpreadChild'
          ],
          offsetTernaryExpressions: true
        }
      ],
      'import/export': 'error',
      'import/first': 'error',
      'import/no-absolute-path': ['error', { esmodule: true, commonjs: true, amd: false }],
      'import/no-duplicates': 'error',
      'import/no-named-default': 'error',
      'import/no-webpack-loader-syntax': 'error',
      'n/handle-callback-err': ['error', '^(err|error)$'],
      'n/no-callback-literal': 'error',
      'n/no-deprecated-api': 'error',
      'n/no-exports-assign': 'error',
      'n/no-new-require': 'error',
      'n/no-path-concat': 'error',
      'n/process-exit-as-throw': 'error',
      'new-cap': ['error', { newIsCap: true, capIsNew: false, properties: true }],
      'no-array-constructor': 'error',
      'no-caller': 'error',
      'no-constant-condition': ['error', { checkLoops: false }], // override config from @eslint/js/recommended
      'no-empty': ['error', { allowEmptyCatch: true }], // override config from @eslint/js/recommended
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-implied-eval': 'error',
      'no-iterator': 'error',
      'no-labels': ['error', { allowLoop: false, allowSwitch: false }],
      'no-lone-blocks': 'error',
      'no-multi-str': 'error',
      'no-new': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-object-constructor': 'error',
      'no-octal-escape': 'error',
      'no-proto': 'error',
      'no-redeclare': ['error', { builtinGlobals: false }], // override config from @eslint/js/recommended
      'no-return-assign': ['error', 'except-parens'],
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-template-curly-in-string': 'error',
      'no-throw-literal': 'error',
      'no-undef-init': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'no-unreachable-loop': 'error',
      'no-unused-vars': [ // override config from @eslint/js/recommended
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          vars: 'all'
        }
      ],
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'no-useless-call': 'error',
      'no-useless-computed-key': 'error',
      'no-useless-constructor': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'no-void': 'error',
      'object-property-newline': [ // TODO: Deprecated, use @stylistic/object-property-newline instead
        'error',
        { allowMultiplePropertiesPerLine: true }
      ],
      'object-shorthand': ['warn', 'properties'],
      'one-var': ['error', { initialized: 'never' }],
      'prefer-const': ['error', { destructuring: 'all' }],
      'prefer-promise-reject-errors': 'error',
      'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
      'promise/param-names': 'error',
      'symbol-description': 'error',
      'unicode-bom': ['error', 'never'],
      'use-isnan': [ // override config from @eslint/js/recommended
        'error',
        { enforceForSwitchCase: true, enforceForIndexOf: true }
      ],
      yoda: ['error', 'never']
    }
  },
  {
    ...eslintPluginN.configs['flat/recommended'],
    ignores: [
      'integration-tests/debugger/target-app/re-evaluation/index.js',
      'integration-tests/debugger/target-app/re-evaluation/unique-filename.js',
      'packages/dd-trace/test/appsec/next/app-dir/**/*.js',
      'packages/dd-trace/test/appsec/next/pages-dir/**/*.js',
      'packages/datadog-plugin-next/test/app/**/*.js',
      'packages/datadog-plugin-next/test/**/pages/**/*.js',
      'packages/datadog-plugin-next/test/middleware.js',
      '**/*.mjs' // TODO: This shoudln't be required, research why it is
    ]
  },
  {
    name: 'dd-trace/defaults',
    plugins: {
      '@stylistic': eslintPluginStylistic,
      import: eslintPluginImport,
      n: eslintPluginN
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
      'import/no-extraneous-dependencies': 'error',
      'n/no-restricted-require': ['error', ['diagnostics_channel']],
      'n/hashbang': 'off', // TODO: Enable this rule once we have a plan to address it
      'n/no-process-exit': 'off', // TODO: Enable this rule once we have a plan to address it
      'n/no-unsupported-features/node-builtins': ['error', {
        ignores: [
          'Request',
          'Response',
          'async_hooks.createHook',
          'async_hooks.executionAsyncId',
          'async_hooks.executionAsyncResource',
          'fetch',
          'fs/promises.cp'
        ]
      }],
      'no-console': 'error',
      'no-prototype-builtins': 'off', // Override (turned on by @eslint/js/recommended)
      'no-var': 'error',
      'require-await': 'error',
      strict: 'error'
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
      },
      n: eslintPluginN,
      unicorn: eslintPluginUnicorn
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
        },
        {
          name: 'get-port',
          message: 'Please listen on port 0 instead.'
        },
        {
          name: 'rimraf',
          message: 'Please use fs.rmSync(path, { recursive: true }) instead.'
        },
        {
          name: 'koalas',
          message: 'Please use ?? instead.'
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

      // These rules require a newer Node.js version than we support
      'unicorn/no-array-reverse': 'off', // Node.js 20
      'unicorn/no-array-sort': 'off', // Node.js 20

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
    name: 'dd-trace/defaults/v0.8-oldest',
    plugins: {
      n: eslintPluginN
    },
    files: [
      'init.js',
      'packages/dd-trace/src/guardrails/**/*',
      'version.js'
    ],
    settings: {
      node: {
        version: '>=0.8.0'
      }
    },
    rules: {
      'eslint-rules/eslint-process-env': 'off', // Would require us to load a module outside the guardrails directory
      'n/no-unsupported-features/es-builtins': ['error', {
        // The following are false positives that are supported in Node.js 0.8.0
        ignores: [
          'JSON',
          'JSON.stringify',
          'parseInt',
          'String'
        ]
      }],
      'n/no-unsupported-features/es-syntax': ['error', {
        // The following are false positives that are supported in Node.js 0.8.0
        ignores: [
          'array-prototype-indexof',
          'json'
        ]
      }],
      'no-var': 'off', // Only supported in Node.js 6+
      'object-shorthand': 'off', // Only supported in Node.js 4+
      'unicorn/prefer-includes': 'off', // Only supported in Node.js 6+
      'unicorn/prefer-number-properties': 'off', // Only supported in Node.js 0.12+
      'unicorn/prefer-optional-catch-binding': 'off', // Only supported in Node.js 10+
      'unicorn/prefer-set-has': 'off', // Only supported in Node.js 0.12+
      'unicorn/prefer-string-replace-all': 'off' // Only supported in Node.js 15+
    }
  },
  {
    name: 'dd-trace/defaults/v16-oldest',
    plugins: {
      n: eslintPluginN
    },
    files: [
      'packages/datadog-plugin-cypress/src/support.js'
    ],
    settings: {
      node: {
        version: '>=16.0.0'
      }
    }
  },
  {
    name: 'dd-trace/defaults/v18-latest',
    plugins: {
      n: eslintPluginN
    },
    files: [
      'benchmark/**/*',
      'scripts/**/*',
      ...TEST_FILES
    ],
    settings: {
      node: {
        version: '>=18' // These files don't have to support the oldest v18 release
      }
    },
    rules: {
      'n/no-unsupported-features/node-builtins': ['error', {
        allowExperimental: true,
        ignores: [
          'module.register'
        ]
      }]
    }
  },
  {
    ...eslintPluginCypress.configs.recommended,
    files: [
      'packages/datadog-plugin-cypress/src/support.js'
    ]
  },
  {
    ...eslintPluginMocha.configs.recommended,
    files: TEST_FILES
  },
  {
    name: 'dd-trace/benchmarks',
    files: [
      'benchmark/**/*'
    ],
    rules: {
      'n/no-missing-require': 'off'
    }
  },
  {
    name: 'dd-trace/tests/all',
    files: TEST_FILES,
    plugins: {
      mocha: eslintPluginMocha,
      n: eslintPluginN
    },
    rules: {
      'mocha/consistent-spacing-between-blocks': 'off',
      'mocha/max-top-level-suites': ['error', { limit: 1 }],
      'mocha/no-mocha-arrows': 'off',
      'mocha/no-setup-in-describe': 'off',
      'mocha/no-sibling-hooks': 'off',
      'mocha/no-top-level-hooks': 'off',
      'n/handle-callback-err': 'off',
      'n/no-missing-require': 'off',
      'require-await': 'off'
    }
  },
  {
    name: 'dd-trace/test-optimization/relaxed',
    files: [
      'integration-tests/ci-visibility/**/*.js',
      'integration-tests/ci-visibility/**/*.mjs',
      'packages/datadog-plugin-jest/test/**/*.js',
      'packages/datadog-plugin-mocha/test/**/*.js',
      'packages/datadog-plugin-cucumber/test/**/*.js',
      'packages/datadog-plugin-cypress/test/**/*.js',
      'packages/datadog-plugin-playwright/test/**/*.js',
      'packages/datadog-plugin-vitest/test/**/*.js',
    ],
    plugins: {
      mocha: eslintPluginMocha,
    },
    rules: {
      'no-undef': 'off',
      'mocha/max-top-level-suites': 'off',
      'mocha/no-pending-tests': 'off',
    }
  },
  {
    name: 'dd-trace/tests/integration-and-resources',
    plugins: {
      import: eslintPluginImport
    },
    files: [
      'integration-tests/**/*.js',
      'integration-tests/**/*.mjs',
      'packages/*/test/integration-test/**/*.js',
      'packages/*/test/integration-test/**/*.mjs',
      // TODO: Move the files in esm-test to integration-test
      'packages/datadog-plugin-graphql/test/esm-test/**/*.mjs',
      'packages/dd-trace/test/appsec/**/resources/**/*.js',
      // TODO: Move the jest-test.js to integration-test
      'packages/datadog-plugin-jest/test/jest-test.js',
    ],
    rules: {
      'import/no-extraneous-dependencies': 'off'
    }
  }
]
