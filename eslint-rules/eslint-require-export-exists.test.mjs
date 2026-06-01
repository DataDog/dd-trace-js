import path from 'node:path'

import { RuleTester } from 'eslint'

import rule from './eslint-require-export-exists.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
})

const fixtureConsumerFile = path.join(
  process.cwd(),
  'eslint-rules/fixtures/require-export-exists/consumer.js'
)

ruleTester.run('eslint-require-export-exists', rule, {
  valid: [
    {
      filename: fixtureConsumerFile,
      code: 'const { foo, bar } = require("./named-exports")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { foo: renamed } = require("./object-exports")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { foo, bar } = require("./json-exports.json")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const baz = require("./named-exports"); baz.bar',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const baz = require("./unknown-exports"); baz.anything',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { nope } = require("semver")',
    },
  ],
  invalid: [
    {
      filename: fixtureConsumerFile,
      code: 'const { qux } = require("./named-exports")',
      errors: [{
        messageId: 'missingExport',
        data: {
          moduleName: './named-exports',
          exportName: 'qux',
        },
      }],
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { baz } = require("./object-exports")',
      errors: [{
        messageId: 'missingExport',
        data: {
          moduleName: './object-exports',
          exportName: 'baz',
        },
      }],
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { baz } = require("./json-exports.json")',
      errors: [{
        messageId: 'missingExport',
        data: {
          moduleName: './json-exports.json',
          exportName: 'baz',
        },
      }],
    },
  ],
})
