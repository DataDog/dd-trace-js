import { RuleTester } from 'eslint'
import rule from './eslint-prefer-assert-object-contains.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2020 },
})

ruleTester.run('prefer-assert-object-contains', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // Below threshold (2 consecutive)
    `
      assert.strictEqual(obj.a, 1)
      assert.strictEqual(obj.b, 2)
    `,
    // Different root objects
    `
      assert.strictEqual(obj.a, 1)
      assert.strictEqual(obj.b, 2)
      assert.strictEqual(other.c, 3)
    `,
    // Interleaved with other statements
    `
      assert.strictEqual(obj.a, 1)
      console.log('test')
      assert.strictEqual(obj.b, 2)
      assert.strictEqual(obj.c, 3)
    `,
    // deepStrictEqual instead of strictEqual
    `
      assert.deepStrictEqual(obj.a, 1)
      assert.deepStrictEqual(obj.b, 2)
      assert.deepStrictEqual(obj.c, 3)
    `,
    // Mixed: some strictEqual and some deepStrictEqual
    `
      assert.strictEqual(obj.a, 1)
      assert.deepStrictEqual(obj.b, 2)
      assert.strictEqual(obj.c, 3)
    `,
  ],
  invalid: [
    {
      code: `
        assert.strictEqual(obj.a, 1)
        assert.strictEqual(obj.b, 2)
        assert.strictEqual(obj.c, 3)
      `,
      errors: [
        {
          messageId: 'preferObjectContains',
          line: 2,
        },
      ],
    },
    {
      code: `
        assert.strictEqual(span.meta.key1, 'v1')
        assert.strictEqual(span.meta.key2, 'v2')
        assert.strictEqual(span.meta.key3, 'v3')
        assert.strictEqual(span.meta.key4, 'v4')
      `,
      errors: [
        {
          messageId: 'preferObjectContains',
          line: 2,
        },
      ],
    },
    {
      code: `
        assert.strictEqual(x.a, 1)
        assert.strictEqual(x.b.c, 2)
        assert.strictEqual(x.d, 3)
      `,
      errors: [
        {
          messageId: 'preferObjectContains',
          line: 2,
        },
      ],
    },
  ],
})
