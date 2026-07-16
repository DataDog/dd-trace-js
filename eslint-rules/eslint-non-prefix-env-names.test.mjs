import { RuleTester } from 'eslint'
import rule from './eslint-non-prefix-env-names.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

function buildMessage (name, source) {
  return `Non-prefixed environment variable '${name}' is read via ${source} but is missing from ` +
    'TRACKED_NON_PREFIX_ENV_NAMES in packages/dd-trace/test/plugins/agent.js. Add it there so the ' +
    'agent.load gate rebuilds the tracer when its value changes between specs.'
}

const missingFooError = { message: buildMessage('FOO', 'getEnvironmentVariable()') }
const missingBarFromEnvSources = { message: buildMessage('BAR', 'getValueFromEnvSources()') }
const missingBazDestructure = { message: buildMessage('BAZ', 'getEnvironmentVariables() destructure') }

ruleTester.run('eslint-non-prefix-env-names', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // DD_/OTEL_/_DD_-prefixed names bypass the allowlist; validation is done by helper.js.
    { code: "getEnvironmentVariable('DD_TRACE_DEBUG')" },
    { code: "getEnvironmentVariable('OTEL_SDK_DISABLED')" },
    { code: "getEnvironmentVariable('_DD_INTERNAL_FLAG')" },
    { code: "getValueFromEnvSources('DD_API_KEY')" },

    // Names registered in TRACKED_NON_PREFIX_ENV_NAMES pass.
    { code: "getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME')" },
    { code: "getEnvironmentVariable('LAMBDA_TASK_ROOT')" },
    { code: "getEnvironmentVariable('HOME')" },
    { code: "getEnvironmentVariable('NODE_OPTIONS')" },
    { code: "getEnvironmentVariable('UV_THREADPOOL_SIZE')" },
    { code: "getValueFromEnvSources('RUNNER_TEMP')" },

    // Member-expression callees resolve the same way.
    { code: "configHelper.getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME')" },
    { code: "configHelper.getEnvironmentVariable('DD_TRACE_DEBUG')" },

    // Template literals with no expressions are treated like string literals.
    { code: 'getEnvironmentVariable(`AWS_LAMBDA_FUNCTION_NAME`)' },
    { code: 'getEnvironmentVariable(`DD_API_KEY`)' },

    // Non-literal first arguments cannot be statically checked.
    { code: "getEnvironmentVariable(envValue.fromEnvVar ?? '')" },
    { code: "getValueFromEnvSources(normalizePluginEnvName('DD_TRACE_X_ENABLED'))" },

    // `process.env.X` is not a CallExpression and is handled by eslint-process-env.
    { code: 'process.env.TOTALLY_NEW_ENV' },

    // `getEnvironmentVariables(source, true)` strips non-prefixed envs from the return value.
    { code: 'const { TOTALLY_NEW_ENV } = getEnvironmentVariables(undefined, true)' },
    { code: 'const { TOTALLY_NEW_ENV } = getEnvironmentVariables(stableConfig.localEntries, true)' },

    // Destructuring registered names is fine.
    { code: 'const { DD_API_KEY, OTEL_SDK_DISABLED, HOME } = getEnvironmentVariables()' },
  ],

  invalid: [
    {
      code: "getEnvironmentVariable('FOO')",
      errors: [missingFooError],
    },
    {
      code: 'getEnvironmentVariable(`FOO`)',
      errors: [missingFooError],
    },
    {
      code: "configHelper.getEnvironmentVariable('FOO')",
      errors: [missingFooError],
    },
    {
      code: "getValueFromEnvSources('BAR')",
      errors: [missingBarFromEnvSources],
    },
    {
      code: 'const { BAZ } = getEnvironmentVariables()',
      errors: [missingBazDestructure],
    },
    {
      code: 'const { BAZ } = getEnvironmentVariables(undefined, false)',
      errors: [missingBazDestructure],
    },
    {
      code: 'const { DD_API_KEY, BAZ } = getEnvironmentVariables()',
      errors: [missingBazDestructure],
    },
  ],
})
