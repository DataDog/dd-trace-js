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
    'const result = { ...(enabled && { [key]: value }) }',
    'const result = { ...(enabled ? { [key]: value } : {}) }',
    'const result = { ...(enabled && { __proto__: prototype }) }',
    'const result = { ...(enabled && { "__proto__": prototype }) }',
    'const result = { ...(enabled && { get value () {} }) }',
    'const result = { ...(enabled && { value () {} }) }',
    'const result = { ...(enabled && { ...source }) }',
    'const result = { ...(enabled ? { value } : { ...fallback }) }',
    'const result = { __proto__: prototype, ...(enabled && { value }) }',
    'const result = { set value (next) {}, ...(enabled && { value }) }',
    'const result = { ...(enabled && { value: 1 }), value: 2 }',
    'const result = { ...(enabled ? { value } : {}), other }',
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
      code: 'const result = { ...(enabled && { value }), ...(ready ? {} : { other }) }',
      errors: [{ messageId: 'assignConditionalProperties' }],
    },
    {
      code: 'const result = { value: first(), ...(enabled && { value: second() }) }',
      errors: [{ messageId: 'assignConditionalProperties' }],
    },
  ],
})
