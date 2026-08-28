import { RuleTester } from 'eslint'

import rule from './eslint-no-conditional-object-spread.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-no-conditional-object-spread', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    'const result = { ...source }',
    'const result = { ...(enabled ? source : fallback) }',
    'const result = { ...(enabled && source) }',
    'const result = { ...(source || { fallback: true }) }',
    'const result = { ...(source ?? { fallback: true }) }',
    'const result = [...(enabled ? [value] : [])]',
  ],
  invalid: [
    {
      code: 'const result = { ...(enabled ? { value } : {}) }',
      errors: [{ messageId: 'assignConditionalProperties' }],
    },
    {
      code: 'const result = { ...(enabled ? { value } : fallback) }',
      errors: [{ messageId: 'assignConditionalProperties' }],
    },
    {
      code: 'const result = { ...(enabled && { value }) }',
      errors: [{ messageId: 'assignConditionalProperties' }],
    },
    {
      code: 'const result = { ...(enabled && { [key]: value }), ...(ready ? {} : { other }) }',
      errors: [
        { messageId: 'assignConditionalProperties' },
        { messageId: 'assignConditionalProperties' },
      ],
    },
  ],
})
