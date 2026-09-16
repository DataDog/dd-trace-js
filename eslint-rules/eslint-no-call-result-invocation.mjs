const FUNCTION_INVOCATION_METHODS = new Set(['apply', 'call'])

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow immediate invocation of functions returned by calls',
      recommended: true,
    },
    schema: [],
    messages: {
      nameReturnedFunction: 'Assign the returned function to a named variable before invoking it.',
    },
  },

  /**
   * @param {import('eslint').Rule.RuleContext} context
   */
  create (context) {
    return {
      /**
       * @param {import('estree').CallExpression} node
       */
      CallExpression (node) {
        const { callee } = node

        if (callee.type === 'CallExpression') {
          context.report({ node, messageId: 'nameReturnedFunction' })
          return
        }

        if (callee.type !== 'MemberExpression' || callee.object.type !== 'CallExpression') return
        if (!FUNCTION_INVOCATION_METHODS.has(getMemberName(callee))) return

        context.report({ node, messageId: 'nameReturnedFunction' })
      },
    }
  },
}

/**
 * @param {import('estree').MemberExpression} member
 * @returns {string|undefined}
 */
function getMemberName (member) {
  const { computed, property } = member

  if (computed) {
    if (property.type === 'Literal' && typeof property.value === 'string') return property.value
    return
  }

  if (property.type === 'Identifier') return property.name
}
