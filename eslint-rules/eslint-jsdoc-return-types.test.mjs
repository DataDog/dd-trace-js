import assert from 'node:assert/strict'

import { RuleTester } from 'eslint'
import eslintPluginJSDoc from 'eslint-plugin-jsdoc'

import eslintConfig from '../eslint.config.mjs'

const ruleEntry = eslintConfig
  .find(({ rules }) => Array.isArray(rules?.['jsdoc/no-restricted-syntax']))
  ?.rules['jsdoc/no-restricted-syntax']

assert.ok(Array.isArray(ruleEntry))
const [, options] = ruleEntry

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  settings: {
    jsdoc: { mode: 'typescript' },
  },
})

const implementation = type => `/** @returns {${type}} */\nfunction value () {}`
const primitiveTypes = ['string', 'number', 'boolean', 'bigint', 'symbol', 'null', 'undefined', 'void']

ruleTester.run('jsdoc/no-restricted-syntax return types', eslintPluginJSDoc.rules['no-restricted-syntax'], {
  valid: [
    ...['Result', 'string | undefined', 'Promise<string>', 'never', '?string', 'string='].map(type => ({
      code: implementation(type),
      options: [options],
    })),
    {
      code: '/** @callback Value\n * @returns {void}\n */\nconst value = 1',
      options: [options],
    },
    {
      code: '/** @overload\n * @returns {string}\n */\nfunction value () {}',
      options: [options],
    },
  ],
  invalid: [
    ...primitiveTypes.map(type => ({
      code: implementation(type),
      options: [options],
      errors: [{ message: 'Primitive return types are inferred and should be omitted.' }],
    })),
    {
      code: '/** @return {string} */\nfunction value () {}',
      options: [options],
      errors: [{ message: 'Primitive return types are inferred and should be omitted.' }],
    },
    {
      code: '/** @returns explanation */\nfunction value () {}',
      options: [options],
      errors: [{ message: 'Return descriptions without a type should be omitted.' }],
    },
    {
      code: '/** @returns */\nfunction value () {}',
      options: [options],
      errors: [{ message: 'Return descriptions without a type should be omitted.' }],
    },
    {
      code: '/** @callback Value\n * @returns explanation\n */\nconst value = 1',
      options: [options],
      errors: [{ message: 'Return descriptions without a type should be omitted.' }],
    },
  ],
})
