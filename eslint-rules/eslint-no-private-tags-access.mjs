const MESSAGE = 'Direct `_tags` access is forbidden; use `getTag()`, `setTag()`, `getTags()`, ' +
  'etc. on the span context instead.'

// Convert a simple glob pattern into a RegExp.
// Supports `**` (any path), `*` (any non-slash run), and `?` (single non-slash char).
// Patterns are anchored at the end of the path; if the pattern does not contain a
// path separator, it matches against the basename. Otherwise it matches against
// any suffix of the path (so callers can write `packages/foo/bar.js` and have it
// match `/abs/path/to/packages/foo/bar.js`).
function patternToRegExp (pattern) {
  // Escape regex metacharacters except for glob wildcards which we handle below.
  // We use placeholder tokens for `**`, `*`, and `?` so the escape step doesn't
  // touch them.
  const DOUBLE_STAR = '\0DSTAR\0'
  const SINGLE_STAR = '\0SSTAR\0'
  const SINGLE_Q = '\0SQ\0'

  let p = pattern
    .replaceAll('**', DOUBLE_STAR)
    .replaceAll('*', SINGLE_STAR)
    .replaceAll('?', SINGLE_Q)

  // Escape remaining regex metacharacters.
  p = p.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')

  // Re-insert glob equivalents.
  p = p
    .replaceAll(DOUBLE_STAR, '.*')
    .replaceAll(SINGLE_STAR, '[^/]*')
    .replaceAll(SINGLE_Q, '[^/]')

  // Anchor: match either at the start of the path or after a `/`, through to
  // the end. This works the same whether the pattern is a basename (no `/`)
  // or a path suffix.
  return new RegExp(`(?:^|/)${p}$`)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct member access to the `_tags` field on span contexts. ' +
        'Use the public accessor API (`getTag`, `setTag`, `getTags`, `hasTag`, `deleteTag`, `clearTags`) instead.',
    },
    messages: {
      noPrivateTagsAccess: MESSAGE,
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
  },

  create (context) {
    const options = context.options[0] || {}
    const allowFiles = Array.isArray(options.allowFiles) ? options.allowFiles : []
    const filename = context.filename || context.getFilename?.() || ''

    // Normalize path separators so glob patterns using `/` match on every platform.
    const normalizedFilename = filename.replaceAll('\\', '/')

    const compiledPatterns = allowFiles.map(patternToRegExp)
    const isAllowed = compiledPatterns.some((re) => re.test(normalizedFilename))

    if (isAllowed) return {}

    return {
      MemberExpression (node) {
        // Skip computed access (e.g. `foo['_tags']` — a string literal — or
        // `foo[Symbol(...)]`). Only `.<identifier>` access counts; the literal
        // and symbol forms are explicitly excluded by the rule spec.
        if (node.computed) return

        const prop = node.property
        if (!prop || prop.type !== 'Identifier' || prop.name !== '_tags') return

        context.report({
          node,
          messageId: 'noPrivateTagsAccess',
        })
      },

      // Catch destructuring access: `const { _tags } = ctx`,
      // `const { _tags: alias } = ctx`, `function f({ _tags }) {}`, etc.
      // Skip computed destructuring (`const { ['_tags']: x } = ctx`) for the
      // same reason we skip computed MemberExpression — the dynamic form is
      // explicitly outside the rule's scope.
      'ObjectPattern > Property' (node) {
        if (node.computed) return

        const key = node.key
        if (!key || key.type !== 'Identifier' || key.name !== '_tags') return

        context.report({
          node,
          messageId: 'noPrivateTagsAccess',
        })
      },
    }
  },
}
