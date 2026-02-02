import { RuleTester } from 'eslint'
import rule from './eslint-log-printf-style.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('eslint-log-printf-style', rule, {
  valid: [
    // Printf-style formatting
    { code: 'log.debug("message %s", value)' },
    { code: 'log.info("count: %d", count)' },
    { code: 'log.warn("Error: %s with code %d", message, code)' },
    { code: 'log.error("Failed with error %s", err)' },

    // Simple string literals (no interpolation)
    { code: 'log.debug("simple message")' },
    { code: 'log.info("no variables here")' },

    // Template literals without expressions
    { code: 'log.debug(`simple template`)' },

    // Not a log call
    { code: 'console.log(`template ${value}`)' }, // eslint-disable-line no-template-curly-in-string
    { code: 'foo.bar("test" + value)' },
  ],

  invalid: [
    // Callback-style logging
    {
      code: 'log.debug(() => "foo")',
      errors: [{
        messageId: 'useFormat',
        data: { method: 'debug', badPattern: 'callback-style logging' },
      }],
    },
    {
      code: 'log.info(() => `message ${value}`)', // eslint-disable-line no-template-curly-in-string
      errors: [{
        messageId: 'useFormat',
        data: { method: 'info', badPattern: 'callback-style logging' },
      }],
    },
    {
      code: 'log.warn(function() { return "message" })',
      errors: [{
        messageId: 'useFormat',
        data: { method: 'warn', badPattern: 'callback-style logging' },
      }],
    },

    // Template literals with expressions
    {
      code: 'log.debug(`message ${value}`)', // eslint-disable-line no-template-curly-in-string
      errors: [{
        messageId: 'useFormat',
        data: { method: 'debug', badPattern: 'template literals' },
      }],
    },
    {
      // eslint-disable-next-line no-template-curly-in-string
      code: 'log.warn(`Error: ${err.message} with code ${err.code}`)',
      errors: [{
        messageId: 'useFormat',
        data: { method: 'warn', badPattern: 'template literals' },
      }],
    },

    // String concatenation
    {
      code: 'log.error("Error: " + message)',
      errors: [{
        messageId: 'useFormat',
        data: { method: 'error', badPattern: 'string concatenation' },
      }],
    },
    {
      code: 'log.info("Count is " + count + " items")',
      errors: [{
        messageId: 'useFormat',
        data: { method: 'info', badPattern: 'string concatenation' },
      }],
    },
    {
      code: 'log.warn("Metric queue exceeded limit (max: " + max + "). Dropping " + dropped + " measurements.")',
      errors: [{
        messageId: 'useFormat',
        data: { method: 'warn', badPattern: 'string concatenation' },
      }],
    },
  ],
})
