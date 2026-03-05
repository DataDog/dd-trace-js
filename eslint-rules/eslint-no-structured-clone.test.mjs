import { RuleTester } from 'eslint'
import rule from './eslint-no-structured-clone.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('eslint-no-structured-clone', rule, {
  valid: [
    { code: 'rfdc(obj)' },
    { code: 'JSON.parse(JSON.stringify(obj))' },
    { code: 'Object.assign({}, obj)' },
    { code: 'const clone = deepClone(obj)' },
  ],

  invalid: [
    {
      code: 'structuredClone(obj)',
      errors: [{
        messageId: 'noStructuredClone',
      }],
    },
    {
      code: 'structuredClone({a: 1})',
      errors: [{
        messageId: 'noStructuredClone',
      }],
    },
    {
      code: 'const copy = structuredClone(data)',
      errors: [{
        messageId: 'noStructuredClone',
      }],
    },
  ],
})
