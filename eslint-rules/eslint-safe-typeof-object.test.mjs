import { RuleTester } from 'eslint'
import rule from './eslint-safe-typeof-object.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2020 },
})

ruleTester.run('no-typeof-object', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
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
    "Boolean(x) && typeof x === 'object'",
    "x != null && typeof x === 'object'",
    "null !== x && typeof x === 'object'",
    "x.y && typeof x.y === 'object'",
    "x?.y != null && typeof x?.y === 'object'",
    "x?.y && typeof x?.y === 'object'",
    "x?.y?.z != null && typeof x.y.z === 'object'",
    "typeof x?.y?.z === 'object' && x.y.z !== null",

    "x !== null && (typeof x === 'object' || typeof x === 'function')",
    "someCondition && x && (typeof x === 'object' || typeof x === 'function')",
    "(x !== null) && (typeof x === 'object' || typeof x === 'function')",
    "!!x && (typeof x === 'object' || typeof x === 'function')",
    "x != null ? typeof x === 'object' : false",
    "x == null ? false : typeof x === 'object'",

    "(x !== null && typeof x === 'object') || typeof x === 'number'",

    "typeof x !== 'object'",
  ],
  invalid: [
    {
      code: "typeof x === 'object'",
      output: "x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "typeof x.y === 'object'",
      output: "x.y !== null && typeof x.y === 'object'",
      errors: 1,
    },
    {
      code: "!x && typeof x === 'object'",
      output: "!x && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "true && typeof x === 'object'",
      output: "true && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "someCondition && someOtherCondition && typeof x === 'object'",
      output: "someCondition && someOtherCondition && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "a && b && c && typeof x === 'object'",
      output: "a && b && c && x !== null && typeof x === 'object'",
      errors: 1,
    },
    {
      code: "(typeof x === 'object' || typeof x === 'function')",
      output: "(x !== null && typeof x === 'object' || typeof x === 'function')",
      errors: 1,
    },
    {
      code: "x && typeof x?.y === 'object'",
      output: "x && x?.y !== null && typeof x?.y === 'object'",
      errors: 1,
    },
  ],
})
