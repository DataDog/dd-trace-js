import { RuleTester } from 'eslint'
import rule from './eslint-no-object-keys-length.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2020 },
})

ruleTester.run('no-object-keys-length', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    'Object.keys(obj)',
    'arr.length === 0',
    'Object.keys(obj).forEach(key => {})',
    "Object.keys(obj).includes('key')",
    'Object.keys(obj).map(key => key)',
    'const len = Object.keys(obj).length',
    'function f() { return Object.keys(obj).length }',
    // Threshold checks should not be flagged
    'Object.keys(obj).length >= 10',
    'Object.keys(obj).length <= 5',
    'Object.keys(obj).length === 3',
  ],
  invalid: [
    {
      code: 'Object.keys(obj).length === 0',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'Object.keys(obj).length !== 0',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'Object.keys(obj).length > 0',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'Object.keys(obj).length < 1',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'Object.keys(obj).length == 0',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'Object.keys(obj).length != 0',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: '!Object.keys(obj).length',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'if (Object.keys(obj).length) {}',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'Object.values(obj).length === 0',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'Object.entries(obj).length === 0',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: 'if (Object.keys(obj).length > 0) {}',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
    {
      code: '!Object.values(obj).length',
      errors: [{ messageId: 'noObjectKeysLength' }],
    },
  ],
})
