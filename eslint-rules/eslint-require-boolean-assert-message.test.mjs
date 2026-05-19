import { RuleTester } from 'eslint'
import rule from './eslint-require-boolean-assert-message.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-require-boolean-assert-message', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // Truthy checks of a value — Node's AssertionError prints the actual value.
    'assert(isReady)',
    'assert.ok(isReady)',
    'assert(this)',
    'assert.ok(true)',
    'assert.ok(obj.prop)',
    'assert.ok(a.b.c.d)',
    'assert.ok(arr[0])',
    "assert.ok(obj['key'])",

    // Dynamic subscripts are also fine: Node shows the actual value at that key.
    'assert.ok(arr[i])',
    'assert.ok(obj[key])',
    'assert.ok(map[`key-${id}`])', // eslint-disable-line no-template-curly-in-string
    'assert.ok(testSpan.meta[TEST_FRAMEWORK_VERSION])',

    // Optional chains.
    'assert.ok(obj?.prop)',
    'assert.ok(obj?.prop?.sub)',

    // Structural unary ops on a trivial operand.
    'assert.ok(!isReady)',
    'assert.ok(!!isReady)',
    'assert(!obj.prop)',
    'assert.ok(typeof x)',
    'assert.ok(delete obj.foo)',

    // `in` and `instanceof` with trivial operands — the source line fully describes the question.
    "assert.ok('foo' in carrier)",
    "assert.ok(!('x-datadog-trace-id' in carrier))",
    'assert.ok(err instanceof Error)',
    'assert.ok(!(err instanceof TypeError))',

    // Non-predicate calls — whatever they return will appear as `actual`. Args don't matter:
    // a complex argument can't make a value-returning call any less informative on failure.
    'assert.ok(getResult())',
    'assert.ok(predicate(x))',
    'assert.ok(getValue(a, b))',
    'assert.ok(arr.find(cb))',
    'assert.ok(arr.find(x => x.foo === "bar"))',
    'assert.ok(items.map(transform))',
    'assert.ok(arr.filter(cb))',
    'assert.ok(buildResult(a + b, foo()))',

    // Zero-arg method calls (getter-style navigation) and composed access.
    'assert.ok(span.context())',
    'assert.ok(span.context()._tags)',
    'assert.ok(arr.entries())',

    // `in` / `instanceof` whose operands are themselves trivial calls.
    'assert.ok(getKey() in carrier)',
    'assert.ok(make() instanceof Error)',

    // `!` of a trivial call (Node shows `actual: false`, but the intent — "should be falsy" — is
    // captured by the surface form, same as `!isReady`).
    'assert.ok(!getResult())',

    // Non-trivial first argument with a message is fine.
    'assert(x > 5, `duration was ${x}`)', // eslint-disable-line no-template-curly-in-string
    "assert.ok(x > 5, 'expected x > 5')",
    "assert.ok(x === 'foo', 'x should be foo')",
    "assert.ok(x && y, 'both should be truthy')",
    "assert.ok(arr.includes('foo'), 'arr should contain foo')",
    "assert.ok(Array.isArray(x), 'x should be an array')",

    // Calls we don't target.
    'assert.strictEqual(x, 5)',
    'assert.deepStrictEqual(x, { foo: 1 })',
    'assert.match(text, /foo/)',
    "assert.fail('nope')",
    'foo.assert(x > 5)',
    'somethingElse(x > 5)',

    // String-matching predicates: intentionally allowed here — the dedicated
    // `eslint-prefer-assert-match` rule handles these and steers users to `assert.match` /
    // `assert.doesNotMatch`. Double-flagging would just produce noisier errors.
    "assert.ok(text.startsWith('foo'))",
    "assert.ok(text.endsWith('bar'))",
    'assert.ok(regex.test(text))',
    'assert.ok(text.match(/foo/))',

    // Spread first argument is opaque to us; don't flag.
    'assert(...args)',
    'assert.ok(...args)',
  ],
  invalid: [
    // Value comparisons hide the actual operand value.
    {
      code: 'assert.ok(duration >= 1000)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(duration < 1050)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: "assert(x === 'foo')",
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(x !== y)',
      errors: [{ messageId: 'missingMessage' }],
    },

    // Logical combinations — composite booleans hide which side was falsy.
    {
      code: 'assert.ok(x && y)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(a || b)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: "assert.ok(typeof x === 'object' && x !== null)",
      errors: [{ messageId: 'missingMessage' }],
    },

    // Boolean-returning predicate methods — `actual: false` doesn't tell you the receiver's value.
    {
      code: "assert.ok(text.includes('foo'))",
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(arr.some(cb))',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(arr.every(cb))',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: "assert.ok(carrier.hasOwnProperty('x-datadog-trace-id'))",
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: "assert.ok(Object.hasOwn(obj, 'k'))",
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(Array.isArray(x))',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(Buffer.isBuffer(x))',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(Number.isFinite(n))',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(buf.equals(other))',
      errors: [{ messageId: 'missingMessage' }],
    },

    // Negated predicate calls — same problem.
    {
      code: "assert.ok(!arr.includes('foo'))",
      errors: [{ messageId: 'missingMessage' }],
    },

    // `!` of a comparison — also boolean-reducing.
    {
      code: 'assert.ok(!(x > 5))',
      errors: [{ messageId: 'missingMessage' }],
    },

    // `in` / `instanceof` with a non-trivial (e.g. binary-expression) operand.
    {
      code: 'assert.ok((a + b) in carrier)',
      errors: [{ messageId: 'missingMessage' }],
    },

    // NewExpression has no meaningful value to print on its own.
    {
      code: 'assert.ok(new Foo())',
      errors: [{ messageId: 'missingMessage' }],
    },
  ],
})
