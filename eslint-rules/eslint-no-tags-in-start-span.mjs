export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid passing a `tags` property in `tracer.startSpan()` options. Integration code must ' +
        'apply tags via `span._addTags()` after creation so that the `tags` option remains ' +
        'exclusively a user-API signal used to detect manual service overrides.',
    },
    schema: [],
    messages: {
      noTagsInStartSpan:
        'Do not pass `tags` in `startSpan()` options. Apply tags after span creation via ' +
        '`span._addTags({ ... })` instead.',
    },
  },

  create (context) {
    return {
      CallExpression (node) {
        const { callee, arguments: args } = node
        if (callee.type !== 'MemberExpression' || callee.computed) return
        if (callee.property.name !== 'startSpan') return

        const options = args[1]
        if (!options || options.type !== 'ObjectExpression') return

        for (const prop of options.properties) {
          if (prop.type !== 'Property') continue
          const key = prop.key
          const keyName = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : undefined
          if (keyName === 'tags') {
            context.report({ node: prop, messageId: 'noTagsInStartSpan' })
          }
        }
      },
    }
  },
}
