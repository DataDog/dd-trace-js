export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer assigning conditional properties instead of spreading intermediate objects',
      recommended: true,
    },
    schema: [],
    messages: {
      assignConditionalProperties:
        'Assign conditional properties after creating the object instead of spreading an intermediate object.',
    },
  },

  /**
   * @param {import('eslint').Rule.RuleContext} context
   */
  create (context) {
    return {
      /**
       * @param {import('estree').SpreadElement} node
       */
      SpreadElement (node) {
        if (node.parent.type !== 'ObjectExpression' || !hasConditionalObject(node.argument)) return

        context.report({
          node,
          messageId: 'assignConditionalProperties',
        })
      },
    }
  },
}

/**
 * @param {import('estree').Expression} node
 * @returns {boolean}
 */
function hasConditionalObject (node) {
  if (node.type === 'ConditionalExpression') {
    return node.consequent.type === 'ObjectExpression' || node.alternate.type === 'ObjectExpression'
  }

  return node.type === 'LogicalExpression' && node.operator === '&&' && node.right.type === 'ObjectExpression'
}
