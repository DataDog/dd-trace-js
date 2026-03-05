import { RuleTester } from 'eslint'
import rule from './eslint-no-does-not-throw.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-no-does-not-throw', rule, {
  valid: [
    'myFunction()',
    'assert.strictEqual(a, b)',
    'assert.deepStrictEqual(a, b)',
    'assert.ok(value)',
    'assert.throws(() => fn())',
    'console.log("test")',
    'logDoesNotThrow()',
  ],

  invalid: [
    // Arrow with expression body
    {
      code: 'assert.doesNotThrow(() => fn())',
      output: 'fn()',
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
    // Function reference
    {
      code: 'assert.doesNotThrow(fn)',
      output: 'fn()',
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
    // Member expression reference
    {
      code: 'assert.doesNotThrow(AppSec.disable)',
      output: 'AppSec.disable()',
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
    // Arrow with extra message argument
    {
      code: 'assert.doesNotThrow(() => fn(), "should not throw")',
      output: 'fn()',
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
    // Arrow with block body (single statement)
    {
      code: 'assert.doesNotThrow(() => { fn() })',
      output: 'fn()',
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
    // Arrow with block body and Error argument
    {
      code: 'assert.doesNotThrow(() => { scope.activate(span) }, Error)',
      output: 'scope.activate(span)',
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
    // Destructured doesNotThrow
    {
      code: [
        'const { doesNotThrow } = require("assert")',
        'doesNotThrow(() => fn())',
      ].join('\n'),
      output: [
        'const { doesNotThrow } = require("assert")',
        'fn()',
      ].join('\n'),
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
    // Destructured from assert/strict
    {
      code: [
        'const { doesNotThrow } = require("assert/strict")',
        'doesNotThrow(fn)',
      ].join('\n'),
      output: [
        'const { doesNotThrow } = require("assert/strict")',
        'fn()',
      ].join('\n'),
      errors: [{ messageId: 'noDoesNotThrow' }],
    },
  ],
})
