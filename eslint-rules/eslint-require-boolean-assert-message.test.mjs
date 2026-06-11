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
    // Value comparisons hide the actual operand value — autofixed by interpolating the operands
    // into a template-literal message.
    {
      code: 'assert.ok(duration >= 1000)',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(duration >= 1000, `Expected ${duration} >= 1000`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(duration < 1050)',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(duration < 1050, `Expected ${duration} < 1050`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(x > 5)',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(x > 5, `Expected ${x} > 5`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(arr.length > 0)',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(arr.length > 0, `Expected ${arr.length} > 0`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(value <= max)',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(value <= max, `Expected ${value} <= ${max}`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    // Surrounding parens — the autofix must place the message OUTSIDE them, otherwise the comma
    // collapses into a sequence expression inside the parens and the assertion becomes a no-op.
    {
      code: 'assert.ok(((x) >= (1)))',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(((x) >= (1)), `Expected ${x} >= 1`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok((x > 5))',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok((x > 5), `Expected ${x} > 5`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    // Loose `==` / `!=` against `null` (intentional "is nullish?" check) — autofix preserves the
    // operator while still surfacing the actual value.
    {
      code: 'assert.ok(x == null)',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(x == null, `Expected ${x} == null`)',
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(x != 0)',
      // eslint-disable-next-line no-template-curly-in-string
      output: 'assert.ok(x != 0, `Expected ${x} != 0`)',
      errors: [{ messageId: 'missingMessage' }],
    },

    // Strict equality / inequality — flagged but NOT autofixed: the better migration is to
    // `assert.strictEqual` / `assert.notStrictEqual` (handled by `no-restricted-syntax` in the
    // eslint config), so a mechanical message wrap here would just compete with that.
    {
      code: "assert(x === 'foo')",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(x !== y)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // Side-effectful or non-reproducible operands — autofix is unsafe because interpolating them
    // re-evaluates the expression with possibly different results (or observable side effects).
    {
      // Plain function call.
      code: 'assert.ok(getX() > 5)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // Function call on either side.
      code: 'assert.ok(arr.length > size())',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // Non-deterministic builtin — value would change between the call and the message.
      code: 'assert.ok(timestamp > Date.now())',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // `++` / `--` mutate state.
      code: 'assert.ok(counter++ > 5)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // Inline assignment.
      code: 'assert.ok((x = getValue()) > 5)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // `new` allocates and may run arbitrary constructor logic.
      code: 'assert.ok(new Date() > startTime)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // Tagged template — the tag function may have side effects.
      code: 'assert.ok(html`<b>${x}</b>` > 0)', // eslint-disable-line no-template-curly-in-string
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // Comma operator runs both expressions for side effects.
      code: 'assert.ok((a, b) > 5)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // String literals containing `${...}` — copying them verbatim into the synthesised
    // backtick template would turn the literal `${...}` into a real interpolation, silently
    // changing the message (or throwing `ReferenceError` if the identifier isn't in scope).
    // Bail rather than try to escape.
    {
      // eslint-disable-next-line no-template-curly-in-string
      code: "assert.ok(value == '${expected}')",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // eslint-disable-next-line no-template-curly-in-string
      code: "assert.ok(x > '${threshold}')",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      // Escaped `${` inside the literal is just as dangerous — the synthesised template
      // would still see `${...}` after the source backslash gets normalised by the parser.
      // eslint-disable-next-line no-template-curly-in-string
      code: "assert.ok(value == 'foo\\${expected}')",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // Logical combinations — composite booleans hide which side was falsy, and there's no
    // mechanical message that's reliably better than what the author would write.
    {
      code: 'assert.ok(x && y)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(a || b)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: "assert.ok(typeof x === 'object' && x !== null)",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // Boolean-returning predicate methods — `actual: false` doesn't tell you the receiver's value.
    // No autofix: producing a meaningful per-predicate message is fuzzy and would require
    // `util.inspect`-style serialisation we can't always synthesise safely.
    {
      code: "assert.ok(text.includes('foo'))",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(arr.some(cb))',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(arr.every(cb))',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: "assert.ok(carrier.hasOwnProperty('x-datadog-trace-id'))",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: "assert.ok(Object.hasOwn(obj, 'k'))",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(Array.isArray(x))',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(Buffer.isBuffer(x))',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(Number.isFinite(n))',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
    {
      code: 'assert.ok(buf.equals(other))',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // Negated predicate calls — same problem.
    {
      code: "assert.ok(!arr.includes('foo'))",
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // `!` of a comparison — also boolean-reducing.
    {
      code: 'assert.ok(!(x > 5))',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // `in` / `instanceof` with a non-trivial (e.g. binary-expression) operand.
    {
      code: 'assert.ok((a + b) in carrier)',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },

    // NewExpression has no meaningful value to print on its own.
    {
      code: 'assert.ok(new Foo())',
      output: null,
      errors: [{ messageId: 'missingMessage' }],
    },
  ],
})
