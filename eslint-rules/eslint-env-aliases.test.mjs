import { RuleTester } from 'eslint'
import rule from './eslint-env-aliases.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('eslint-env-aliases', rule, {
  valid: [
    { code: "const env = 'DD_TRACE_PROPAGATION_STYLE'" },
    { code: 'const env = `OTEL_EXPORTER_OTLP_ENDPOINT`' },
    { code: "const env = 'DD_TRACE_PROPAGATION_STYLE_INJECT'" },
  ],

  invalid: [
    {
      code: "const env = 'DD_PROFILING_EXPERIMENTAL_CPU_ENABLED'",
      output: "const env = 'DD_PROFILING_CPU_ENABLED'",
      errors: [{
        message: "Use canonical environment variable name 'DD_PROFILING_CPU_ENABLED' " +
                 "instead of alias 'DD_PROFILING_EXPERIMENTAL_CPU_ENABLED'",
      }],
    },
    {
      code: 'const env = `DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED`',
      output: "const env = 'DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED'",
      errors: [{
        message: "Use canonical environment variable name 'DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED' " +
                 "instead of alias 'DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED'",
      }],
    },
  ],
})
