export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow structuredClone() in production code. The tracer runs in application hot paths ' +
        'and structuredClone is relatively slow. Use rfdc (vendored deep clone) instead.',
    },
    messages: {
      noStructuredClone:
        'Do not use structuredClone() in production code — it is slow. ' +
        'Use rfdc (vendored) for deep cloning instead.',
    },
    schema: [],
  },
  create (context) {
    return {
      CallExpression (node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'structuredClone') {
          context.report({
            node,
            messageId: 'noStructuredClone',
          })
        }
      },
    }
  },
}
