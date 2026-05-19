import { RuleTester } from 'eslint'
import rule from './eslint-prefer-assert-match.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('eslint-prefer-assert-match', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    // Direct, idiomatic assertions we don't want to touch.
    'assert.match(x, /foo/)',
    'assert.doesNotMatch(x, /foo/)',
    'assert.ok(x)',
    'assert.ok(x === y)',
    'assert.ok(x.length > 0)',
    'assert.ok(fn())',

    // .includes() is intentionally not handled (could be Array or String).
    'assert.ok(arr.includes(item))',
    "assert.ok(str.includes('foo'))",
    'assert.ok(!arr.includes(item))',

    // Patterns wrapped in .some() / .every() etc. aren't direct string matches.
    "assert.ok(tags.some(tag => tag.startsWith('entrypoint.')))",
    'assert.ok(items.every(item => /foo/.test(item)))',
    'assert.ok(!names.some(n => /foo/.test(n)))',

    // The .ok must be on `assert` specifically, not arbitrary identifiers.
    "expect.ok(x.startsWith('foo'))",
    "result.ok(x.endsWith('bar'))",
    "ok(x.startsWith('foo'))",

    // Computed property access shouldn't match.
    "assert['ok'](x.startsWith('foo'))",

    // Too many arguments (assert.ok accepts at most 2).
    "assert.ok(x.startsWith('foo'), 'msg', 'extra')",

    // Method called with wrong arity on the inner side.
    'assert.ok(x.startsWith())',
    "assert.ok(x.startsWith('a', 1))",
  ],

  invalid: [
    // ── RegExp.test() ─────────────────────────────────────────────────────
    {
      code: 'assert.ok(/foo/.test(x))',
      output: 'assert.match(x, /foo/)',
      errors: [{ messageId: 'preferMatch', data: { method: 'test' } }],
    },
    {
      code: 'assert.ok(/foo/i.test(x.y))',
      output: 'assert.match(x.y, /foo/i)',
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(/foo/.test(x), 'message')",
      output: "assert.match(x, /foo/, 'message')",
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: 'assert.ok(!/foo/.test(x))',
      output: 'assert.doesNotMatch(x, /foo/)',
      errors: [{ messageId: 'preferDoesNotMatch', data: { method: 'test' } }],
    },
    {
      code: "assert.ok(!/foo/.test(x), 'should not match')",
      output: "assert.doesNotMatch(x, /foo/, 'should not match')",
      errors: [{ messageId: 'preferDoesNotMatch' }],
    },
    // Non-regex-literal receivers of `.test()` are reported but not auto-fixed:
    // the receiver might not be a RegExp (e.g. a Joi schema, AJV instance, or
    // any other helper with a `.test()` method), so blindly rewriting to
    // `assert.match(x, re)` could throw `TypeError: regexp must be a RegExp`.
    {
      code: 'assert.ok(re.test(x))',
      output: null,
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: 'assert.ok(predicate.test(value))',
      output: null,
      errors: [{ messageId: 'preferMatch', data: { method: 'test' } }],
    },

    // ── String.prototype.match() ──────────────────────────────────────────
    {
      code: 'assert.ok(x.match(/foo/))',
      output: 'assert.match(x, /foo/)',
      errors: [{ messageId: 'preferMatch', data: { method: 'match' } }],
    },
    {
      code: 'assert.ok(!x.match(/foo/g))',
      output: 'assert.doesNotMatch(x, /foo/g)',
      errors: [{ messageId: 'preferDoesNotMatch' }],
    },
    // .match() with a non-regex-literal argument: report but don't auto-fix
    // (string arg has different runtime semantics under assert.match).
    {
      code: 'assert.ok(x.match(pattern))',
      output: null,
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(x.match('foo'))",
      output: null,
      errors: [{ messageId: 'preferMatch' }],
    },

    // ── String.prototype.startsWith() ─────────────────────────────────────
    {
      code: "assert.ok(x.startsWith('foo'))",
      output: 'assert.match(x, /^foo/)',
      errors: [{ messageId: 'preferMatch', data: { method: 'startsWith' } }],
    },
    // Regex metacharacters must be escaped inside the produced regex literal.
    {
      code: "assert.ok(x.startsWith('foo.bar'))",
      output: 'assert.match(x, /^foo\\.bar/)',
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(x.startsWith('a/b'))",
      output: 'assert.match(x, /^a\\/b/)',
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(x.startsWith('(a)*'))",
      output: 'assert.match(x, /^\\(a\\)\\*/)',
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(x.startsWith('foo'), 'starts with foo')",
      output: "assert.match(x, /^foo/, 'starts with foo')",
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(!x.startsWith('foo'))",
      output: 'assert.doesNotMatch(x, /^foo/)',
      errors: [{ messageId: 'preferDoesNotMatch', data: { method: 'startsWith' } }],
    },
    // Non-literal arg: report only.
    {
      code: 'assert.ok(x.startsWith(prefix))',
      output: null,
      errors: [{ messageId: 'preferMatch' }],
    },
    // Template literal arg: report only (interpolation values aren't known).
    {
      // eslint-disable-next-line no-template-curly-in-string
      code: 'assert.ok(x.startsWith(`foo${bar}`))',
      output: null,
      errors: [{ messageId: 'preferMatch' }],
    },
    // String containing a real newline can't be embedded in a regex literal.
    {
      code: "assert.ok(x.startsWith('foo\\nbar'))",
      output: null,
      errors: [{ messageId: 'preferMatch' }],
    },

    // ── String.prototype.endsWith() ───────────────────────────────────────
    {
      code: "assert.ok(x.endsWith('...'))",
      output: 'assert.match(x, /\\.\\.\\.$/)',
      errors: [{ messageId: 'preferMatch', data: { method: 'endsWith' } }],
    },
    {
      code: "assert.ok(x.endsWith('.js'))",
      output: 'assert.match(x, /\\.js$/)',
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(!x.endsWith('foo'))",
      output: 'assert.doesNotMatch(x, /foo$/)',
      errors: [{ messageId: 'preferDoesNotMatch' }],
    },

    // ── Member chains on the string side ──────────────────────────────────
    {
      code: "assert.ok(obj.prop.startsWith('foo'))",
      output: 'assert.match(obj.prop, /^foo/)',
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: "assert.ok(obj?.prop?.endsWith('bar'))",
      output: 'assert.match(obj?.prop, /bar$/)',
      errors: [{ messageId: 'preferMatch' }],
    },
    {
      code: 'assert.ok(getString().match(/foo/))',
      output: 'assert.match(getString(), /foo/)',
      errors: [{ messageId: 'preferMatch' }],
    },
  ],
})
