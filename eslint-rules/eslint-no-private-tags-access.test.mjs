import { RuleTester } from 'eslint'
import rule from './eslint-no-private-tags-access.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run('eslint-no-private-tags-access', rule, {
  valid: [
    // Public accessors are fine.
    { code: 'span.context().getTag("k")' },
    { code: 'span.context().setTag("k", "v")' },
    { code: 'span.context().getTags()' },
    { code: 'span.context().hasTag("k")' },
    { code: 'span.context().deleteTag("k")' },
    { code: 'span.context().clearTags()' },

    // Object-literal key named `_tags` is a shorthand/Property, not a MemberExpression.
    { code: 'const x = { _tags: {} }' },

    // String literal `'_tags'` is just a string literal.
    { code: 'const key = "_tags"' },

    // Computed access via bracket notation with a string literal should be ignored.
    { code: 'const v = ctx["_tags"]' },

    // Computed access via Symbol should also be ignored.
    { code: 'const t = ctx[Symbol("_tags")]' },

    // File on the allowlist may freely access `_tags`.
    {
      code: 'ctx._tags = {}',
      options: [{ allowFiles: ['allowed.js'] }],
      filename: '/path/to/allowed.js',
    },
    {
      code: 'ctx._tags = {}',
      options: [{ allowFiles: ['packages/dd-trace/src/opentracing/span_context.js'] }],
      filename: '/abs/repo/packages/dd-trace/src/opentracing/span_context.js',
    },
    {
      code: 'ctx._tags = {}',
      options: [{ allowFiles: ['packages/dd-trace/test/opentracing/*.spec.js'] }],
      filename: '/abs/repo/packages/dd-trace/test/opentracing/span_context.spec.js',
    },

    // Unrelated `_tags` reference on the basename glob — allowlist matches all.
    {
      code: 'ctx._tags["k"]',
      options: [{ allowFiles: ['**/*.spec.js'] }],
      filename: '/abs/repo/test/foo.spec.js',
    },

    // Computed destructuring (dynamic) — same exclusion as computed MemberExpression.
    { code: 'const { ["_tags"]: x } = ctx' },

    // The destructured *source* property is `tags`, not `_tags`; renaming the
    // local binding to `_tags` is fine.
    { code: 'const { tags: _tags } = ctx' },

    // Destructuring inside an allowlisted file should be permitted.
    {
      code: 'const { _tags } = ctx',
      options: [{ allowFiles: ['allowed.js'] }],
      filename: '/path/to/allowed.js',
    },
    {
      code: 'const { _tags: aliased } = ctx',
      options: [{ allowFiles: ['**/*.spec.js'] }],
      filename: '/abs/repo/test/foo.spec.js',
    },
  ],

  invalid: [
    {
      code: 'const v = ctx._tags',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },
    {
      code: 'ctx._tags = {}',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },
    {
      code: 'span.context()._tags["k"]',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },
    {
      code: 'span.context()._tags.foo',
      // `span.context()._tags` is one violation; the outer `.foo` access is
      // separate and not a `_tags` access, so only one error.
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },

    // Allowlist that doesn't match the current file should still error.
    {
      code: 'ctx._tags = {}',
      options: [{ allowFiles: ['some/other/file.js'] }],
      filename: '/abs/repo/packages/dd-trace/src/foo.js',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },

    // Destructuring access — shorthand.
    {
      code: 'const { _tags } = ctx',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },

    // Destructuring access — renamed.
    {
      code: 'const { _tags: aliased } = ctx',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },

    // Destructuring in a function parameter.
    {
      code: 'function f ({ _tags }) { return _tags }',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },

    // Nested destructuring still gets flagged.
    {
      code: 'const { context: { _tags } } = span',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },

    // Destructuring with a non-matching allowlist should still error.
    {
      code: 'const { _tags } = ctx',
      options: [{ allowFiles: ['some/other/file.js'] }],
      filename: '/abs/repo/packages/dd-trace/src/foo.js',
      errors: [{ messageId: 'noPrivateTagsAccess' }],
    },
  ],
})

// eslint-disable-next-line no-console
console.log('eslint-no-private-tags-access tests passed')
