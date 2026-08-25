// TODO: once we've well iterated on this file (6 months+),
// we can plan to move it to its own package to reuse elsewhere.
// written on 2026-02-12

import { readFileSync } from 'fs'
import eslintPluginJs from '@eslint/js'
import eslintPluginStylistic from '@stylistic/eslint-plugin'
import eslintPluginCypress from 'eslint-plugin-cypress'
import eslintPluginImport from 'eslint-plugin-import-x'
import eslintPluginJSDoc from 'eslint-plugin-jsdoc'
import eslintPluginMocha from 'eslint-plugin-mocha'
import eslintPluginN from 'eslint-plugin-n'
import eslintPluginPromise from 'eslint-plugin-promise'
import eslintPluginSonar from 'eslint-plugin-sonarjs'
import eslintPluginUnicorn from 'eslint-plugin-unicorn'
import globals from 'globals'

import { carrierFieldsConfig } from './eslint-rules/carrier-fields-policy.mjs'
import eslintCarrierFields from './eslint-rules/eslint-carrier-fields.mjs'
import eslintConfigNamesSync from './eslint-rules/eslint-config-names-sync.mjs'
import eslintEnvAliases from './eslint-rules/eslint-env-aliases.mjs'
import eslintLogPrintfStyle from './eslint-rules/eslint-log-printf-style.mjs'
import eslintNoPrivateTagsAccess from './eslint-rules/eslint-no-private-tags-access.mjs'
import eslintNoProcessEnvDisable from './eslint-rules/eslint-no-process-env-disable.mjs'
import eslintNonPrefixEnvNames from './eslint-rules/eslint-non-prefix-env-names.mjs'
import eslintPreferAssertMatch from './eslint-rules/eslint-prefer-assert-match.mjs'
import eslintPreferSetServiceName from './eslint-rules/eslint-prefer-set-service-name.mjs'
import eslintProcessEnv from './eslint-rules/eslint-process-env.mjs'
import eslintRequireAgentStop from './eslint-rules/eslint-require-agent-stop.mjs'
import eslintRequireBooleanAssertMessage from './eslint-rules/eslint-require-boolean-assert-message.mjs'
import eslintRequireExportExists from './eslint-rules/eslint-require-export-exists.mjs'
import eslintSafeTypeOfObject from './eslint-rules/eslint-safe-typeof-object.mjs'
import eslintTimerUnref from './eslint-rules/eslint-timer-unref.mjs'

const { dependencies } = JSON.parse(readFileSync('./vendor/package.json', 'utf8'))

const SRC_FILES = [
  '*.js',
  '*.mjs',
  'ext/**/*.js',
  'ext/**/*.mjs',
  'ci/**/*.js',
  'ci/**/*.mjs',
  'scripts/**/*.js',
  'scripts/**/*.mjs',
  'packages/*/*.js',
  'packages/*/*.mjs',
  'packages/*/src/**/*.js',
  'packages/*/src/**/*.mjs',
]

const PROCESS_ENV_DISABLE_ALLOW_FILES = [
  '.mochamultireporterrc.js',
  'ci/diagnose.js',
  'ci/init.js',
  'ci/test-optimization-validation/command-runner.js',
  'ci/vitest-no-worker-init-setup.mjs',
  'nyc.config.js',
  'packages/datadog-esbuild/index.js',
  'packages/datadog-esbuild/src/log.js',
  'packages/datadog-instrumentations/src/cypress-config.js',
  'packages/datadog-instrumentations/src/mocha/main.js',
  'packages/datadog-instrumentations/src/vitest.js',
  'packages/datadog-webpack/src/log.js',
  'packages/dd-trace/src/ci-visibility/exporters/ci-validation/index.js',
  'packages/dd-trace/src/ci-visibility/test-optimization-cache.js',
  'packages/dd-trace/src/ci-visibility/test-optimization-http-cache.js',
  'packages/dd-trace/src/config/helper.js',
  'packages/dd-trace/src/config/index.js',
  'packages/dd-trace/src/config/stable.js',
  'packages/dd-trace/src/debugger/index.js',
  'packages/dd-trace/src/log/index.js',
  'packages/dd-trace/src/telemetry/session-propagation.js',
]

const TEST_FILES = [
  'packages/*/test/**/*.js',
  'packages/*/test/**/*.mjs',
  'integration-tests/**/*.js',
  'integration-tests/**/*.mjs',
  '**/*.spec.js',
]

const GLOBAL_RESTRICTED_REQUIRES = [
  {
    name: 'diagnostics_channel',
    message: 'Please use `dc-polyfill` instead.',
  },
  {
    name: 'get-port',
    message: 'Please listen on port 0 instead.',
  },
  {
    name: 'rimraf',
    message: 'Please use `fs.rm(path, { recursive: true, force: true })` instead.',
  },
  {
    name: 'koalas',
    message: 'Please use nullish coalescing operator (??) instead.',
  },
  {
    name: 'chai',
    message: 'Please use `node:assert/strict` instead.',
  },
  {
    name: 'tap',
    message: 'Please use `mocha` instead.',
  },
]

const SRC_RESTRICTED_SYNTAX = [
  {
    // Inline `.evaluate(<fn>)` callbacks (Playwright/Puppeteer) are serialized with
    // `toString()` and run in chromium — coverage counters inside would ReferenceError.
    selector:
      "CallExpression[callee.property.name='evaluate']" +
      ":matches([arguments.0.type='ArrowFunctionExpression'], [arguments.0.type='FunctionExpression'])",
    message:
      'Move the inline `.evaluate(...)` callback into a `*-browser-scripts.js` file ' +
      '(NYC-excluded in nyc.config.js) and import it here.',
  },
  {
    // Static-analysis bundlers (esbuild, webpack, rollup) only see literals as require
    // arguments; once any transform (e.g. NYC) wraps them, this shape breaks bundling.
    selector: "CallExpression[callee.name='require'][arguments.0.type='ConditionalExpression']",
    message: 'Use `cond ? require(\'a\') : require(\'b\')` instead of `require(cond ? \'a\' : \'b\')`.',
  },
]

// Matches only probe positions; a genuine count (`writeMapPrefix(Object.keys(x).length)`) must stay allowed.
const OBJECT_KEYS_LENGTH_PROBE = {
  selector:
    ':matches(BinaryExpression[right.value=0], BinaryExpression[left.value=0], UnaryExpression[operator="!"],' +
    ' IfStatement, ConditionalExpression, LogicalExpression, WhileStatement, DoWhileStatement)' +
    " > MemberExpression[property.name='length']" +
    " > CallExpression[callee.object.name='Object'][callee.property.name='keys']",
  message: 'Do not probe emptiness with `Object.keys(obj).length`; the keys array is allocated on every call. ' +
    'Track presence with a boolean at the assignment site, probe a known key (`obj.field !== undefined`), or ' +
    'return `undefined` when there is nothing to report instead of an empty object.',
}

export default [
  {
    name: 'dd-trace/global-ignore',
    ignores: [
      '**/.bun', // Ignore autogenerated bun files
      '**/coverage', // Just coverage reports.
      '!**/integration-tests/coverage', // The integration-test coverage harness lives here, not a report.
      '!**/integration-tests/coverage/**',
      '**/dist', // Generated
      '**/docs', // Any JS here is for presentation only.
      '**/.next', // Generated Next.js build output
      '**/out', // Generated
      '**/node_modules', // We don't own these.
      '**/versions', // This is effectively a node_modules tree.
      '**/acmeair-nodejs', // We don't own this.
      '**/vendor', // Generally, we didn't author this code.
      '**/.analysis', // Ignore apm-instrumentation-toolkit analysis results
      'integration-tests/ci-visibility/test-management/test-suite-failed-to-run-parse.js', // Intentional syntax error
      'integration-tests/code-origin/typescript.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/bundle.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/hello/world.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/minify.min.js', // Generated
      'integration-tests/debugger/target-app/source-map-support/typescript.js', // Generated
      'integration-tests/esbuild/out.js', // Generated
      'integration-tests/esbuild/aws-sdk-out.js', // Generated
      'packages/datadog-plugin-graphql/src/tools/index.js', // Inlined from apollo-graphql
    ],
  },
  eslintPluginJs.configs.recommended,
  eslintPluginJSDoc.configs['flat/recommended'],
  {
    // TODO: Move these rules to dd-trace/defaults or where they otherwise belong.
    name: 'standard',
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.es2022,
        ...globals.node,
        document: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
      },
    },
    plugins: {
      '@stylistic': eslintPluginStylistic,
      jsdoc: eslintPluginJSDoc,
      import: eslintPluginImport,
      n: eslintPluginN,
      promise: eslintPluginPromise,
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
        { overrides: { '?': 'before', ':': 'before', '|>': 'before' } },
      ],
      '@stylistic/padded-blocks': [
        'error',
        { blocks: 'never', switches: 'never', classes: 'never' },
      ],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/quotes': [
        'error',
        'single',
        { avoidEscape: true, allowTemplateLiterals: 'never' },
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
            exceptions: ['*'],
          },
        },
      ],
      '@stylistic/template-curly-spacing': ['error', 'never'],
      '@stylistic/template-tag-spacing': ['error', 'never'],
      '@stylistic/wrap-iife': ['error', 'any', { functionPrototypeMethods: true }],
      '@stylistic/yield-star-spacing': ['error', 'both'],
      'accessor-pairs': ['error', { setWithoutGet: true, enforceForClassMembers: true }],
      'array-callback-return': ['error', { allowImplicit: false, checkForEach: false }],
      'block-scoped-var': 'error',
      'brace-style': [ // TODO: Deprecated, use @stylistic/brace-style instead
        'error',
        '1tbs',
        { allowSingleLine: true },
      ],
      camelcase: [
        'error',
        {
          allow: ['^UNSAFE_'],
          properties: 'never',
          ignoreGlobals: true,
        },
      ],
      'comma-style': ['error', 'last'], // TODO: Deprecated, use @stylistic/comma-style instead
      curly: ['error', 'multi-line'],
      'default-case-last': 'error',
      'dot-notation': ['error', { allowKeywords: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'func-call-spacing': ['error', 'never'], // TODO: Deprecated, use @stylistic/func-call-spacing instead
      'grouped-accessor-pairs': ['error', 'getBeforeSet'],
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
            'JSXSpreadChild',
          ],
          offsetTernaryExpressions: true,
        },
      ],
      'import/export': 'error',
      'import/first': 'error',
      'import/no-absolute-path': ['error', { esmodule: true, commonjs: true, amd: false }],
      'import/no-amd': 'error',
      'import/no-cycle': 'error',
      'import/no-duplicates': 'error',
      'import/no-empty-named-blocks': 'error',
      'import/no-import-module-exports': 'error',
      'import/no-mutable-exports': 'error',
      'import/no-named-default': 'error',
      'import/no-self-import': 'error',
      'import/order': ['error', {
        // `dd-trace` must be allowed first (and is often intentionally required before any other module).
        // eslint-plugin-import-x defaults can exclude some import types (notably `builtin`) from `pathGroups`,
        // which would make the `dd-trace` exception below a no-op. Make this explicit.
        pathGroupsExcludedImportTypes: [],
        pathGroups: [
          {
            pattern: 'dd-trace',
            group: 'builtin',
            position: 'before',
          },
        ],
      }],
      'import/no-useless-path-segments': 'error',
      'import/no-webpack-loader-syntax': 'error',
      // The option keeps `@overload` blocks that document fewer params than the implementation.
      'jsdoc/check-param-names': ['error', { disableMissingParamChecks: true }],
      'jsdoc/check-tag-names': ['error', { definedTags: ['datadog'] }],
      'jsdoc/check-template-names': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/no-bad-blocks': 'error',
      'jsdoc/no-blank-blocks': 'error',
      // TODO: Enable the rules that we want to use.
      'jsdoc/no-defaults': 'error',
      'jsdoc/no-undefined-types': 'error',
      'jsdoc/reject-function-type': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off', // Having a description is not crucial for now.
      'jsdoc/require-param': 'error',
      'jsdoc/require-property-description': 'off',
      'jsdoc/require-returns-check': 'error',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-template': 'error',
      'jsdoc/require-throws-description': 'error',
      'jsdoc/require-yields-description': 'error',
      'jsdoc/tag-lines': 'off', // Alignment is not important for us.
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
      'no-constructor-return': 'error',
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
          vars: 'all',
        },
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
        { allowMultiplePropertiesPerLine: true },
      ],
      'object-shorthand': ['warn', 'properties'],
      'one-var': ['error', { initialized: 'never' }],
      'prefer-const': ['error', { destructuring: 'all' }],
      'prefer-numeric-literals': 'error',
      'prefer-promise-reject-errors': 'error',
      'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
      // 6 errors. Attaching `cause` changes error output, so it needs its own change.
      'preserve-caught-error': 'off',
      'promise/no-new-statics': 'error',
      'promise/no-return-in-finally': 'error',
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/spec-only': 'error',
      'promise/valid-params': 'error',
      'symbol-description': 'error',
      'unicode-bom': ['error', 'never'],
      'use-isnan': [ // override config from @eslint/js/recommended
        'error',
        { enforceForSwitchCase: true, enforceForIndexOf: true },
      ],
      yoda: ['error', 'never'],
    },
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
      '**/*.mjs', // TODO: This shouldn't be required, research why it is
    ],
  },
  {
    name: 'dd-trace/defaults',
    plugins: {
      '@stylistic': eslintPluginStylistic,
      'eslint-rules': {
        rules: {
          'eslint-carrier-fields': eslintCarrierFields,
          'eslint-process-env': eslintProcessEnv,
          'eslint-env-aliases': eslintEnvAliases,
          'eslint-config-names-sync': eslintConfigNamesSync,
          'eslint-non-prefix-env-names': eslintNonPrefixEnvNames,
          'eslint-no-process-env-disable': eslintNoProcessEnvDisable,
          'eslint-prefer-assert-match': eslintPreferAssertMatch,
          'eslint-prefer-set-service-name': eslintPreferSetServiceName,
          'eslint-safe-typeof-object': eslintSafeTypeOfObject,
          'eslint-log-printf-style': eslintLogPrintfStyle,
          'eslint-no-private-tags-access': eslintNoPrivateTagsAccess,
          'eslint-require-agent-stop': eslintRequireAgentStop,
          'eslint-require-boolean-assert-message': eslintRequireBooleanAssertMessage,
          'eslint-require-export-exists': eslintRequireExportExists,
          'eslint-timer-unref': eslintTimerUnref,
        },
      },
      import: eslintPluginImport,
      n: eslintPluginN,
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      ecmaVersion: 2022,
    },
    settings: {
      node: {
        // Used by `eslint-plugin-n` to determine the minimum version of Node.js to support.
        // Normally setting this in the `package.json` engines field is enough, but when we have more than one active
        // major release line at the same time, we need to specify the lowest version here to ensure backporting will
        // not fail.
        version: '>=18.0.0',
      },
      jsdoc: { mode: 'typescript' },
    },
    rules: {
      '@stylistic/max-len': ['error', { code: 120, tabWidth: 2, ignoreUrls: true, ignoreRegExpLiterals: true }],
      '@stylistic/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'only-multiline',
        importAttributes: 'always-multiline',
        dynamicImports: 'always-multiline',
      }],
      'eslint-rules/eslint-safe-typeof-object': 'error',
      'eslint-rules/eslint-no-private-tags-access': ['error', {
        allowFiles: [
          // The span_context implementation defines and reads `_tags` directly.
          'packages/dd-trace/src/opentracing/span_context.js',
          // Unrelated `_tags` fields on other classes (not span contexts).
          'packages/dd-trace/src/dogstatsd.js',
          'packages/dd-trace/src/datastreams/processor.js',
          // `LLMObservabilitySpan` (internal LLM-Obs DTO) has its own `_tags`
          // field unrelated to the APM span context.
          'packages/dd-trace/src/llmobs/span_processor.js',
          // Test specs that intentionally mock the `_tags` field shape on a
          // fake span context (their `getTag`/`getTags` mocks read `this._tags`).
          'packages/dd-trace/test/priority_sampler.spec.js',
          'packages/dd-trace/test/sampling_rule.spec.js',
          'packages/dd-trace/test/span_sampler.spec.js',
          'packages/dd-trace/test/span_format.spec.js',
          'packages/dd-trace/test/standalone/tracesource_priority_sampler.spec.js',
          'packages/dd-trace/test/appsec/reporter.spec.js',
          'packages/dd-trace/test/appsec/index.spec.js',
          'packages/dd-trace/test/plugins/database-dbm-hash.spec.js',
          'packages/dd-trace/test/plugins/outbound.spec.js',
          'packages/dd-trace/test/llmobs/tagger.spec.js',
          'packages/dd-trace/test/llmobs/span_processor.spec.js',
          'packages/dd-trace/test/profiling/profilers/wall.spec.js',
          // Benchmark stubs that mock the `_tags` field shape on a fake span
          // context (their `getTag`/`getTags` mocks read from `_tags`).
          'benchmark/sirun/exporting-pipeline/index.js',
        ],
      }],
      'eslint-rules/eslint-require-export-exists': 'error',
      'import/no-extraneous-dependencies': 'error',
      // 72 errors. Instrumentation has to publish its finish event after invoking the wrapped
      // callback, so returning the callback call would drop the event.
      'n/callback-return': 'off',
      'n/hashbang': 'error',
      'n/no-extraneous-require': ['error', {
        allowModules: Object.keys(dependencies),
      }],
      'n/no-mixed-requires': 'error',
      'n/no-process-exit': 'error',
      'n/no-restricted-require': ['error', GLOBAL_RESTRICTED_REQUIRES],
      'n/no-unpublished-require': ['error', {
        allowModules: Object.keys(dependencies),
      }],
      'n/no-unsupported-features/node-builtins': ['error', {
        ignores: [
          'Request',
          'Response',
          'async_hooks.createHook',
          'async_hooks.executionAsyncId',
          'async_hooks.executionAsyncResource',
          'fetch',
          'fs/promises.cp',
        ],
      }],
      'no-console': 'error',
      'no-implicit-coercion': ['error', { boolean: true, number: true, string: true, allow: ['!!'] }],
      // 107 errors, all of them the `new Promise(resolve => setTimeout(resolve, ms))` shape.
      // `no-async-promise-executor` already covers the executor footgun that loses errors.
      'no-promise-executor-return': 'off',
      'no-prototype-builtins': 'off', // Override (turned on by @eslint/js/recommended)
      'no-return-assign': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-useless-assignment': 'error',
      'no-var': 'error',
      'no-void': ['error', { allowAsStatement: true }],
      'operator-assignment': 'error',
      'prefer-exponentiation-operator': 'error',
      'prefer-object-has-own': 'error',
      'prefer-object-spread': 'error',
      radix: 'error',
      // 49 errors, all in single-flow init or test scaffolding. The one site with real
      // concurrency (the debugger's breakpoint bookkeeping) already runs behind a lock.
      'require-atomic-updates': 'off',
      'require-await': 'error',
      strict: 'error',
    },
  },
  {
    name: 'dd-trace/sonar',
    // Apply SonarJS to both production and test code. Many SonarJS rules are test-oriented.
    plugins: {
      sonarjs: eslintPluginSonar,
    },
    rules: {
      'sonarjs/anchor-precedence': 'error',
      'sonarjs/arguments-order': 'error',
      'sonarjs/comma-or-logical-or-case': 'error',
      'sonarjs/duplicates-in-character-class': 'error',
      'sonarjs/empty-string-repetition': 'error',
      'sonarjs/inverted-assertion-arguments': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-case-label-in-switch': 'error',
      'sonarjs/no-code-after-done': 'error',
      'sonarjs/no-collection-size-mischeck': 'error',
      'sonarjs/no-commented-code': 'error',
      'sonarjs/no-duplicated-branches': 'error',
      'sonarjs/no-empty-after-reluctant': 'error',
      'sonarjs/no-empty-collection': 'error',
      'sonarjs/no-empty-group': 'error',
      'sonarjs/no-equals-in-for-termination': 'error',
      'sonarjs/no-extra-arguments': 'error',
      'sonarjs/no-globals-shadowing': 'error',
      'sonarjs/no-gratuitous-expressions': 'error',
      'sonarjs/no-identical-conditions': 'error',
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-ignored-exceptions': 'error',
      'sonarjs/no-invariant-returns': 'error',
      'sonarjs/no-mixed-completion-style': 'error',
      'sonarjs/no-nested-assignment': 'error',
      'sonarjs/no-parameter-reassignment': 'error',
      'sonarjs/no-redundant-assignments': 'error',
      'sonarjs/no-redundant-jump': 'error',
      'sonarjs/no-small-switch': 'error',
      'sonarjs/no-unthrown-error': 'error',
      'sonarjs/no-unused-collection': 'error',
      'sonarjs/no-use-of-empty-return-value': 'error',
      'sonarjs/no-variable-usage-before-declaration': 'error',
      'sonarjs/non-existent-operator': 'error',
      'sonarjs/prefer-immediate-return': 'error',
      'sonarjs/prefer-promise-shorthand': 'error',
      'sonarjs/prefer-single-boolean-return': 'error',
      'sonarjs/prefer-while': 'error',
      'sonarjs/reduce-initial-value': 'error',
      'sonarjs/single-char-in-character-classes': 'error',
      'sonarjs/single-character-alternation': 'error',
      'sonarjs/slow-regex': 'error',
      'sonarjs/stable-tests': 'error',
      'sonarjs/synchronous-suite-callback': 'error',
      'sonarjs/test-check-exception': 'error',
      'sonarjs/unicode-aware-regex': 'error',
      'sonarjs/updated-loop-counter': 'error',

      // --- Rules to check later ------------------
      // SonarJS rules marked `requiresTypeChecking` report nothing without a TypeScript program, so they
      // read as clean while catching nothing. Enabling them needs typescript-eslint wired up first.
      'sonarjs/no-element-overwrite': 'off', // 3 errors (false positives)
      // 37 errors, all false positives: those suites are built by shared helper factories
      // (`assertPromise`, `prepareTestServerForIast`) instead of literal `it()` calls.
      'sonarjs/no-empty-test-file': 'off',
      'sonarjs/todo-tag': 'off', // 434 errors. We use TODO/FIXME as tracked markers by policy.
    },
  },
  {
    name: 'dd-trace/src/all',
    files: SRC_FILES,
    plugins: {
      unicorn: eslintPluginUnicorn,
    },
    rules: {
      'eslint-rules/eslint-no-process-env-disable': ['error', {
        allowFiles: PROCESS_ENV_DISABLE_ALLOW_FILES,
      }],
      'eslint-rules/eslint-process-env': 'error',
      'eslint-rules/eslint-env-aliases': 'error',
      'eslint-rules/eslint-log-printf-style': 'error',
      'eslint-rules/eslint-non-prefix-env-names': 'error',
      'eslint-rules/eslint-prefer-set-service-name': 'error',
      'eslint-rules/eslint-timer-unref': 'error',

      'no-restricted-syntax': ['error', ...SRC_RESTRICTED_SYNTAX],

      'n/no-restricted-require': ['error', [
        ...GLOBAL_RESTRICTED_REQUIRES,
        {
          name: 'semver',
          message: 'Please use `semifies` instead.',
        },
      ]],

      'no-await-in-loop': 'error',
      'no-else-return': ['error', { allowElseIf: true }],
      'no-unused-expressions': 'error',

      // Too strict for now. Slowly migrate to this rule by using rest parameters.
      // 'prefer-rest-params': 'error',

      ...eslintPluginUnicorn.configs.recommended.rules,

      // Not in `recommended`: the innerHTML sink class and unread object properties.
      'unicorn/iteration-fallback-style': 'error',
      'unicorn/no-unsafe-dom-html': 'error',
      'unicorn/no-unused-properties': 'error',

      // Overriding recommended unicorn rules.
      // Rules not listed here are left at the `recommended` default. The entries below
      // document deliberate exceptions. Volume markers stay coarse so they do not drift:
      // `few` is under ten sites, `many` is tens, `lots` is hundreds or more.
      'unicorn/catch-error-name': ['off', { name: 'err' }], // lots
      'unicorn/filename-case': ['off', { case: 'kebabCase' }], // lots
      'unicorn/name-replacements': 'off', // lots | naming churn (split out of prevent-abbreviations)
      'unicorn/prevent-abbreviations': 'off', // Its replacements moved to name-replacements

      // These rules require a newer Node.js version than we support
      'unicorn/no-array-reverse': 'off', // Node.js 20
      'unicorn/no-array-sort': 'off', // Node.js 20
      'unicorn/prefer-abort-signal-any': 'off', // Node.js 18.17
      'unicorn/prefer-dispose': 'off', // Explicit resource management (newer Node.js)
      'unicorn/prefer-group-by': 'off', // Node.js 21
      'unicorn/prefer-iterator-helpers': 'off', // Iterator helpers (Node.js 22)
      'unicorn/prefer-iterator-to-array': 'off', // Iterator helpers (Node.js 22)
      'unicorn/prefer-iterator-to-array-at-end': 'off', // Iterator helpers (Node.js 22)
      'unicorn/prefer-promise-try': 'off', // Promise.try (Node.js 24)
      'unicorn/prefer-promise-with-resolvers': 'off', // few | Promise.withResolvers (Node.js 22)
      'unicorn/prefer-set-methods': 'off', // Set methods (Node.js 22)
      'unicorn/prefer-temporal': 'off', // Temporal is not stable on supported Node.js
      'unicorn/prefer-uint8array-base64': 'off', // Uint8Array base64 (Node.js 22)

      // These rules could potentially be evaluated again at a much later point
      'unicorn/class-reference-in-static-methods': 'off', // few
      'unicorn/consistent-class-member-order': 'off', // many | ordering churn
      'unicorn/consistent-conditional-object-spread': 'off', // many
      'unicorn/explicit-length-check': 'off', // Not a big advantage
      'unicorn/explicit-timer-delay': 'off', // Covered by our own timer lint rules
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/no-computed-property-existence-check': 'off', // lots | needs an audit
      'unicorn/no-declarations-before-early-exit': 'off', // many
      'unicorn/no-error-property-assignment': 'off', // few | all preserve upstream error metadata
      'unicorn/no-for-loop': 'off', // Activate if this is resolved https://github.com/sindresorhus/eslint-plugin-unicorn/issues/2664
      'unicorn/no-nonstandard-builtin-properties': 'off', // many | needs an audit
      'unicorn/no-this-assignment': 'off', // This would need some further refactoring and the benefit is small
      'unicorn/no-undeclared-class-members': 'off', // lots | requires declaring every field
      'unicorn/no-unreadable-array-destructuring': 'off', // few | not autofixable, needs manual rewrite
      'unicorn/no-unreadable-for-of-expression': 'off', // many
      'unicorn/no-unreadable-object-destructuring': 'off', // many
      'unicorn/no-unsafe-string-replacement': 'off', // many | replacement callbacks reduce readability
      'unicorn/no-useless-recursion': 'off', // few | iterative rewrites add substantial nesting
      'unicorn/prefer-code-point': 'off', // Should be activated, but needs a refactor of some code
      'unicorn/prefer-early-return': 'off', // many | tension with our positive-`if` style
      'unicorn/prefer-number-is-safe-integer': 'off', // many
      'unicorn/prefer-object-iterable-methods': 'off', // many
      'unicorn/prefer-queue-microtask': 'off', // process.nextTick semantics differ
      'unicorn/prefer-simple-condition-first': 'off', // lots | needs a short-circuit behavior audit
      'unicorn/prefer-then-catch': 'off', // many | broadens rejection boundaries
      'unicorn/require-array-sort-compare': 'off', // many | many intentional lexicographic sorts
      'unicorn/single-line-block-comment-style': 'off', // lots | preserve compact JSDoc typedefs

      // The following rules should not be activated!
      'unicorn/consistent-boolean-name': 'off', // Would rename public API and config booleans
      'unicorn/import-style': 'off', // Questionable benefit
      'unicorn/max-nested-calls': 'off', // Questionable benefit
      'unicorn/no-array-reduce': 'off', // Questionable benefit
      'unicorn/no-array-splice': 'off', // toSpliced copies the whole array (perf)
      'unicorn/no-break-in-nested-loop': 'off', // Conflicts with our performance-oriented loops
      'unicorn/no-global-object-property-assignment': 'off', // We use globalThis[Symbol.for('dd-trace')]
      'unicorn/no-negated-array-predicate': 'off', // Predicate inversion is harder to read and creates churn
      'unicorn/no-negated-comparison': 'off', // Opposite comparisons do not preserve NaN handling
      'unicorn/no-nested-ternary': 'off', // Not really an issue in the code and the benefit is small
      'unicorn/no-new-array': 'off', // new Array is often used for performance reasons
      'unicorn/no-null': 'off', // We do not control external APIs and it is hard to differentiate these
      'unicorn/no-return-array-push': 'off', // Questionable benefit
      'unicorn/no-this-outside-of-class': 'off', // This will not work for us
      'unicorn/no-top-level-assignment-in-function': 'off', // Module-level singletons are assigned from functions
      'unicorn/no-useless-else': 'off', // Covered by core no-else-return
      'unicorn/operator-assignment': 'off', // Covered by core operator-assignment
      'unicorn/prefer-array-last-methods': 'off', // Questionable benefit
      'unicorn/prefer-await': 'off', // We avoid async/await in production hot paths
      'unicorn/prefer-dom-node-html-methods': 'off', // Browser compatibility and different serialization semantics
      'unicorn/prefer-event-target': 'off', // Benefit only outside of Node.js
      'unicorn/prefer-global-this': 'off', // Questionable benefit in Node.js alone
      'unicorn/prefer-includes-over-repeated-comparisons': 'off', // Bad for performance
      'unicorn/prefer-math-trunc': 'off', // Math.trunc is not a 1-to-1 replacement for most of our usage
      'unicorn/prefer-minimal-ternary': 'off', // Conflicts with our restricted-syntax rule on require(cond ? a : b)
      'unicorn/prefer-module': 'off', // We use CJS
      'unicorn/prefer-node-protocol': 'off', // May not be used due to guardrails
      'unicorn/prefer-number-coercion': 'off', // Number() is not a 1-to-1 replacement for parseInt/parseFloat
      'unicorn/prefer-private-class-fields': 'off', // Many `_underscore` fields cross module boundaries
      'unicorn/prefer-reflect-apply': 'off', // lots | questionable benefit
      'unicorn/prefer-short-arrow-method': 'off', // Method shorthand is intentional; arrow properties change `this`
      'unicorn/prefer-split-limit': 'off', // A limit is slower than getSegment; the rest read every segment
      'unicorn/prefer-switch': 'off', // Questionable benefit
      'unicorn/prefer-top-level-await': 'off', // Only useful when using ESM
      'unicorn/prefer-unicode-code-point-escapes': 'off', // Replaces the dropped no-hex-escape; questionable benefit
      'unicorn/switch-case-braces': 'off', // Questionable benefit

      // These remaining rules need focused rewrites before activation.
      'unicorn/no-confusing-array-splice': 'off', // few
      'unicorn/no-for-each': 'off', // many | we already prefer for-of in production
      'unicorn/no-unnecessary-global-this': 'off', // few | explicit globals are clearer
      'unicorn/prefer-array-from-map': 'off', // few | loops avoid callback allocation
      'unicorn/prefer-continue': 'off', // many
      'unicorn/prefer-ternary': 'off', // many
    },
  },
  {
    name: 'dd-trace/unicorn/all',
    // Unicorn is otherwise limited to production code, and `sonarjs/no-ignored-exceptions`
    // reports only a subset of the unused catch bindings in tests and fixtures.
    plugins: {
      unicorn: eslintPluginUnicorn,
    },
    rules: {
      'unicorn/consistent-date-clone': 'error',
      'unicorn/prefer-optional-catch-binding': 'error',
    },
  },
  {
    name: 'dd-trace/packages/src',
    files: [
      'packages/*/src/**/*.js',
      'packages/*/src/**/*.mjs',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...SRC_RESTRICTED_SYNTAX, OBJECT_KEYS_LENGTH_PROBE],
    },
  },
  {
    name: 'dd-trace/config-sync',
    files: [
      'eslint.config.mjs',
    ],
    rules: {
      'eslint-rules/eslint-config-names-sync': ['error', {
        indexDtsPaths: ['index.d.ts', 'index.d.v5.ts'],
      }],
    },
  },
  {
    name: 'dd-trace/scripts',
    files: [
      'scripts/**/*.js',
      'scripts/**/*.mjs',
    ],
    rules: {
      'eslint-rules/eslint-process-env': 'off',
      // Scripts are CLI/dev tooling where process.exit and shebangs are acceptable.
      'n/hashbang': 'off',
      'n/no-process-exit': 'off',
      'unicorn/no-process-exit': 'off',
    },
  },
  {
    // Benchmarks and integration test scaffolding are standalone scripts. Shebangs
    // are used so they can be invoked as `./script.js`, and `process.exit` is the
    // expected exit signal for these driver / harness programs.
    name: 'dd-trace/scripts/runnable-fixtures',
    files: [
      'benchmark/**/*.js',
      'benchmark/**/*.mjs',
      'integration-tests/**/*.js',
      'integration-tests/**/*.mjs',
      'packages/datadog-instrumentations/test/helpers/check-require-cache/**/*.js',
      'packages/datadog-instrumentations/test/helpers/hook-module-views/**/*.js',
      'packages/datadog-plugin-net/test/epipe-crash/**/*.js',
      'packages/datadog-plugin-openai/test/no-init.js',
      'packages/dd-trace/test/custom-metrics-app.js',
      'packages/datadog-plugin-aws-durable-execution-sdk-js/test/integration-test/server.mjs',
      'packages/datadog-plugin-fastify/test/integration-test/helper.mjs',
      'packages/datadog-plugin-light-my-request/test/integration-test/server.mjs',
    ],
    plugins: {
      n: eslintPluginN,
    },
    rules: {
      'n/hashbang': 'off',
      'n/no-process-exit': 'off',
    },
  },
  {
    name: 'dd-trace/defaults/v0.8-oldest',
    plugins: {
      n: eslintPluginN,
    },
    files: [
      'init.js',
      'packages/dd-trace/src/guardrails/**/*',
      'packages/dd-trace/src/log/levels.js', // Required by the guardrails logger.
      'version.js',
    ],
    settings: {
      node: {
        version: '>=0.8.0',
      },
    },
    rules: {
      '@stylistic/comma-dangle': 'off', // Only supported in Node.js 0.10+
      'eslint-rules/eslint-process-env': 'off', // Would require us to load a module outside the guardrails directory
      'n/no-unsupported-features/es-builtins': ['error', {
        // The following are false positives that are supported in Node.js 0.8.0
        ignores: [
          'JSON',
          'JSON.parse',
          'JSON.stringify',
          'Object.keys',
          'parseInt',
          'String',
        ],
      }],
      'n/no-unsupported-features/es-syntax': ['error', {
        // The following are false positives that are supported in Node.js 0.8.0
        ignores: [
          'array-prototype-indexof',
          'json',
          'object-keys',
        ],
      }],
      'no-var': 'off', // Only supported in Node.js 6+
      'object-shorthand': 'off', // Only supported in Node.js 4+
      // The binding cannot be dropped without optional catch binding (Node.js 10+).
      'sonarjs/no-ignored-exceptions': 'off',
      'unicorn/prefer-includes': 'off', // Only supported in Node.js 6+
      'unicorn/prefer-number-properties': 'off', // Only supported in Node.js 0.12+
      'unicorn/prefer-optional-catch-binding': 'off', // Only supported in Node.js 10+
      'unicorn/prefer-set-has': 'off', // Only supported in Node.js 0.12+
      'unicorn/prefer-string-replace-all': 'off', // Only supported in Node.js 15+
    },
  },
  {
    name: 'dd-trace/defaults/v16-oldest',
    plugins: {
      n: eslintPluginN,
    },
    files: [
      'packages/datadog-plugin-cypress/src/support.js',
    ],
    settings: {
      node: {
        version: '>=16.0.0',
      },
    },
  },
  {
    name: 'dd-trace/defaults/v18-latest',
    plugins: {
      n: eslintPluginN,
    },
    files: [
      'benchmark/**/*',
      'scripts/**/*',
      ...TEST_FILES,
    ],
    settings: {
      node: {
        version: '>=18', // These files don't have to support the oldest v18 release
      },
    },
    rules: {
      'n/no-unsupported-features/node-builtins': ['error', {
        allowExperimental: true,
        ignores: [
          'module.register',
        ],
      }],
    },
  },
  {
    ...eslintPluginCypress.configs.recommended,
    files: [
      'packages/datadog-plugin-cypress/src/support.js',
    ],
  },
  {
    ...eslintPluginMocha.configs.recommended,
    files: TEST_FILES,
  },
  {
    name: 'dd-trace/benchmarks',
    files: [
      'benchmark/**/*',
    ],
    rules: {
      'n/no-missing-require': 'off',
    },
  },
  {
    name: 'dd-trace/tests/all',
    files: TEST_FILES,
    plugins: {
      mocha: eslintPluginMocha,
      n: eslintPluginN,
    },
    rules: {
      'eslint-rules/eslint-prefer-assert-match': 'error',
      'eslint-rules/eslint-require-agent-stop': 'error',
      // TODO: Re-enable this rule once we have a way to fix the false positives or have Node.js report better errors.
      'eslint-rules/eslint-require-boolean-assert-message': 'off',
      'mocha/consistent-spacing-between-blocks': 'off',
      'mocha/consistent-structure': 'off',
      'mocha/handle-done-callback': 'off',
      'mocha/max-top-level-suites': ['error', { limit: 1 }],
      'mocha/no-async-in-sync-tests': 'off',
      'mocha/no-conditional-tests': 'off',
      'mocha/no-mocha-arrows': 'off',
      'mocha/no-pending-tests': 'off',
      'mocha/no-root-hooks': 'off',
      'mocha/no-setup-in-suite': 'off',
      'n/handle-callback-err': 'off',
      'n/no-extraneous-require': ['error', {
        allowModules: [
          ...Object.keys(dependencies),
          'mocha',
        ],
      }],
      'no-restricted-syntax': ['error', {
        selector: "CallExpression:matches([callee.name='doesNotThrow'], [callee.property.name='doesNotThrow'])",
        message: 'Do not use `assert.doesNotThrow()`. Execute the expression directly instead.',
      }, {
        // `assert(a === b)` / `assert.ok(a === b)` → `assert.strictEqual(a, b)`
        selector:
          'CallExpression[arguments.length<=2]' +
          ':matches([callee.name="assert"], [callee.object.name="assert"][callee.property.name="ok"])' +
          ' > BinaryExpression[operator="==="]:first-child',
        message: 'Use `assert.strictEqual(a, b)` instead of `assert(a === b)` / `assert.ok(a === b)`. ' +
          'The strict variant includes both values in the failure message automatically.',
      }, {
        // `assert(a !== b)` / `assert.ok(a !== b)` → `assert.notStrictEqual(a, b)`
        selector:
          'CallExpression[arguments.length<=2]' +
          ':matches([callee.name="assert"], [callee.object.name="assert"][callee.property.name="ok"])' +
          ' > BinaryExpression[operator="!=="]:first-child',
        message: 'Use `assert.notStrictEqual(a, b)` instead of `assert(a !== b)` / `assert.ok(a !== b)`. ' +
          'The strict variant includes both values in the failure message automatically.',
      }],
      'n/no-missing-require': 'off',
      'require-await': 'off',
    },
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
    languageOptions: {
      globals: {
        afterAll: 'readonly',
        beforeAll: 'readonly',
        expect: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      'mocha/no-pending-tests': 'off',
    },
  },
  {
    // jest-docblock's `@datadog {"unskippable": true}` tag reads as a malformed
    // JSDoc type to `jsdoc/valid-types`. The shape is required by the plugin.
    name: 'dd-trace/datadog-plugin-jest/fixtures',
    files: ['packages/datadog-plugin-jest/test/fixtures/**/*.js'],
    rules: {
      'jsdoc/valid-types': 'off',
    },
  },
  {
    // CI-visibility retry fixtures intentionally call `this.retries(N)` to
    // exercise the dd-trace test-optimization retry code paths. The fixtures
    // ARE the flaky tests that the plugin watches.
    name: 'dd-trace/tests/ci-visibility-retry-fixtures',
    files: [
      'integration-tests/ci-visibility/jest-plugin-tests/**/*.js',
      'integration-tests/ci-visibility/mocha-hooks/**/*.js',
      'integration-tests/ci-visibility/mocha-plugin-tests/**/*.js',
      'integration-tests/ci-visibility/mocha-retries-test-fn/**/*.js',
      'integration-tests/ci-visibility/test-nested-hooks/**/*.js',
    ],
    plugins: {
      sonarjs: eslintPluginSonar,
    },
    rules: {
      'sonarjs/stable-tests': 'off',
    },
  },
  {
    // These fixture apps import dd-trace the way a customer does
    // (`require('dd-trace')`), so dd-trace never appears in their own manifest.
    // Both extraneous-require rules must be off; otherwise the rule fires
    // whenever dd-trace happens to be resolvable locally (e.g. `yarn link`),
    // even though CI's clean install keeps it unresolvable.
    name: 'dd-trace/tests/integration-and-resources',
    plugins: {
      import: eslintPluginImport,
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
      'import/no-extraneous-dependencies': 'off',
      'n/no-extraneous-require': 'off',
    },
  },
  {
    name: 'dd-trace/openfeature',
    plugins: {
      promise: eslintPluginPromise,
    },
    files: [
      'packages/dd-trace/src/openfeature/**/*.js',
      'packages/dd-trace/test/openfeature/**/*.js',
    ],
    rules: {
      // The OpenFeature hook API defines `finally(hookContext, evalDetails)`, which the rule
      // reads as `Promise.prototype.finally`.
      'promise/valid-params': 'off',
    },
  },
  ...carrierFieldsConfig,
  {
    // The Next.js fixture apps import dd-trace the way a customer does
    // (`require('dd-trace')`). The package is supplied to the app at runtime via a
    // stub written into node_modules (see test/index.spec.js), so it never appears
    // in a manifest the extraneous-dependency rules can read.
    name: 'dd-trace/datadog-plugin-next/fixtures',
    plugins: {
      import: eslintPluginImport,
    },
    files: [
      'packages/datadog-plugin-next/test/app/**/*.js',
      'packages/datadog-plugin-next/test/**/pages/**/*.js',
    ],
    rules: {
      'import/no-extraneous-dependencies': 'off',
      'n/no-extraneous-require': 'off',
    },
  },
]
