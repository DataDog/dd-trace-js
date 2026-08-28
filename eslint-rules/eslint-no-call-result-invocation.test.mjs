import { RuleTester } from 'eslint'
import rule from './eslint-no-call-result-invocation.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('eslint-no-call-result-invocation', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    'const run = factory(); run()',
    'const run = promisify(fn); run(value)',
    '(() => value)()',
    '(function () { return value })()',
    '(async () => value)()',
    'factory().method()',
    'consume(factory())',
    'const run = factory().bind(owner)',
  ],
  invalid: [
    {
      code: 'factory()()',
      errors: [{ messageId: 'nameReturnedFunction' }],
    },
    {
      code: 'factory()?.()',
      errors: [{ messageId: 'nameReturnedFunction' }],
    },
    {
      code: 'promisify(fn)(value)',
      errors: [{ messageId: 'nameReturnedFunction' }],
    },
    {
      code: 'factory()(...args)',
      errors: [{ messageId: 'nameReturnedFunction' }],
    },
    {
      code: 'factory().call(owner, value)',
      errors: [{ messageId: 'nameReturnedFunction' }],
    },
    {
      code: "factory()['apply'](owner, values)",
      errors: [{ messageId: 'nameReturnedFunction' }],
    },
    {
      code: 'factory().bind(owner)(value)',
      errors: [{ messageId: 'nameReturnedFunction' }],
    },
  ],
})
