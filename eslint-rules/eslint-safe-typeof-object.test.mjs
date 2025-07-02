import { RuleTester } from 'eslint'
import rule from './eslint-safe-typeof-object.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2015 }
})

ruleTester.run('no-typeof-object', rule, {
  valid: [
    "x !== null && typeof x === 'object'",
    "typeof x === 'object' && x !== null",

    "x.y !== null && typeof x.y === 'object'",

    "true && x !== null && typeof x === 'object'",
    "someCondition && x !== null && typeof x === 'object'",
    "someCheck() && x !== null && typeof x === 'object'",
    "a && b && x !== null && typeof x === 'object'",

    "x && typeof x === 'object'",
    "!!x && typeof x === 'object'",

    "x !== null && (typeof x === 'object' || typeof x === 'function')",
    "someCondition && x && (typeof x === 'object' || typeof x === 'function')",
    "(x !== null) && (typeof x === 'object' || typeof x === 'function')",
    "!!x && (typeof x === 'object' || typeof x === 'function')",

    "(x !== null && typeof x === 'object') || typeof x === 'number'",

    "typeof x !== 'object'"
  ],
  invalid: [
    {
      code: "typeof x === 'object'",
      output: "x !== null && typeof x === 'object'",
      errors: 1
    },
    {
      code: "typeof x.y === 'object'",
      output: "x.y !== null && typeof x.y === 'object'",
      errors: 1
    },
    {
      code: "!x && typeof x === 'object'",
      output: "!x && x !== null && typeof x === 'object'",
      errors: 1
    },
    {
      code: "true && typeof x === 'object'",
      output: "true && x !== null && typeof x === 'object'",
      errors: 1
    },
    {
      code: "someCondition && someOtherCondition && typeof x === 'object'",
      output: "someCondition && someOtherCondition && x !== null && typeof x === 'object'",
      errors: 1
    },
    {
      code: "a && b && c && typeof x === 'object'",
      output: "a && b && c && x !== null && typeof x === 'object'",
      errors: 1
    },
    {
      code: "(typeof x === 'object' || typeof x === 'function')",
      output: "(x !== null && typeof x === 'object' || typeof x === 'function')",
      errors: 1
    }
  ]
})
