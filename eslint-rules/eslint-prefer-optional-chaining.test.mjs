import { RuleTester } from 'eslint'

import rule from './eslint-prefer-optional-chaining.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

ruleTester.run('eslint-prefer-optional-chaining', rule, {
  valid: [
    // Already using optional chaining
    { code: 'x?.y' },
    { code: 'x?.y?.z' },
    { code: 'x?.y?.z()' },

    // Different identifiers — not a guard pattern
    { code: 'a && b.c' },
    { code: 'x && y.z' },

    // Nullish coalescing — not a guard
    { code: 'x ?? x.y' },

    // Non-member access on right side
    { code: 'x && y' },
    { code: 'x && foo()' },

    // Already optional
    { code: 'x && x?.y' },

    // Right side doesn't extend left
    { code: 'x.a && x.b' },

    // Single operand
    { code: 'x.y' },

    // Not detected yet: guard in binary/call expression (future enhancement)
    { code: 'x && x.y > 0' },
    { code: 'x && fn(x.y)' },

    // Not all negated in || chain
    { code: '!x || x.y' },
    { code: 'x || !x.y' },
  ],

  invalid: [
    // -------------------------------------------------------
    // Pattern 1: x && x.y → x?.y
    // -------------------------------------------------------
    {
      // Basic: x && x.y
      code: 'x && x.y',
      output: 'x?.y',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Real review: response && response.prompt
      code: 'inputs.prompt && response && response.prompt',
      output: 'inputs.prompt && response?.prompt',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Multi-step chain: x && x.y && x.y.z
      code: 'x && x.y && x.y.z',
      output: 'x?.y?.z',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Real review: Message && Message.prototype && Message.prototype.ack
      code: 'Message && Message.prototype && Message.prototype.ack',
      output: 'Message?.prototype?.ack',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Bracket access: x && x['y']
      code: "x && x['y']",
      output: "x?.['y']",
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Method call: x && x.y()
      code: 'x && x.y()',
      output: 'x?.y()',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Direct function call: x && x(arg)
      code: 'x && x(arg)',
      output: 'x?.(arg)',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Bracket access on deeper path: errors && errors[0]
      code: 'errors && errors[0]',
      output: 'errors?.[0]',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Prefix preserved: a && b && b.c
      code: 'a && b && b.c',
      output: 'a && b?.c',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Deep member access: x.data && x.data.trees
      code: 'parsed.data && parsed.data.trees',
      output: 'parsed.data?.trees',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },

    // -------------------------------------------------------
    // Pattern 2: !x || !x.y → !x?.y
    // -------------------------------------------------------
    {
      // Basic: !x || !x.y
      code: '!x || !x.y',
      output: '!x?.y',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Real review: !options || !options.ddApiKey
      code: '!options || !options.ddApiKey',
      output: '!options?.ddApiKey',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
    {
      // Multi-step: !x || !x.y || !x.y.z
      code: '!x || !x.y || !x.y.z',
      output: '!x?.y?.z',
      errors: [{ messageId: 'preferOptionalChaining' }],
    },
  ],
})
