import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { ESLint, RuleTester } from 'eslint'

import rule from './eslint-process-env.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const message = 'Use getValueFromEnvSources() for registered tracer configuration or getEnvironmentVariable() only ' +
  'for raw internal/runtime values from packages/dd-trace/src/config/helper.js. Ask in the guild channel before ' +
  'disabling this rule.'

ruleTester.run('eslint-process-env', rule, {
  valid: [
    { code: "getEnvironmentVariable('DD_TRACE_DEBUG')" },
  ],

  invalid: [
    {
      code: 'process.env',
      errors: [{ message }],
    },
  ],
})

const eslint = new ESLint({
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  applySuppressions: false,
})
const directiveCases = [
  "/* eslint-disable eslint-rules/eslint-process-env */\nprocess.env.FOO = 'value'",
  "process.env.FOO = 'value' // eslint-disable-line eslint-rules/eslint-process-env",
  "// eslint-disable-next-line eslint-rules/eslint-process-env\nprocess.env.FOO = 'value'",
]

for (const code of directiveCases) {
  const [result] = await eslint.lintText(code, {
    filePath: 'packages/dd-trace/src/eslint-process-env-test.js',
  })
  let warningCommentErrors = 0
  for (const error of result.messages) {
    if (error.ruleId === 'no-warning-comments') warningCommentErrors++
  }
  assert.strictEqual(warningCommentErrors, 1)
}

for (const filePath of ['.mochamultireporterrc.js', 'nyc.config.js']) {
  const [testConfigResult] = await eslint.lintText('process.env.FOO', { filePath })
  for (const error of testConfigResult.messages) {
    assert.notStrictEqual(error.ruleId, 'eslint-rules/eslint-process-env')
  }

  const [directiveResult] = await eslint.lintText(directiveCases[2], { filePath })
  for (const error of directiveResult.messages) {
    assert.notStrictEqual(error.ruleId, 'no-warning-comments')
  }
}
