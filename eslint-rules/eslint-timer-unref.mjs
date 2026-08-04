export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce `timer.unref?.()` over `timer.unref()`. Electron does not implement `unref` on ' +
        'timer objects returned by setTimeout/setInterval/etc., so calling it directly would throw.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      useOptionalChain:
        'Use `timer.unref?.()` instead of `timer.unref()` — Electron timers do not have an `unref` method.',
    },
  },

  create (context) {
    return {
      CallExpression (node) {
        if (
          node.optional ||
          node.callee.type !== 'MemberExpression' ||
          node.callee.computed ||
          node.callee.property.name !== 'unref'
        ) {
          return
        }

        context.report({
          node,
          messageId: 'useOptionalChain',
          fix (fixer) {
            return fixer.insertTextAfter(node.callee, '?.')
          },
        })
      },
    }
  },
}
