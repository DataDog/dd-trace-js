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
        if (
          node.parent.type !== 'ObjectExpression' ||
          node.parent.properties.at(-1) !== node ||
          !hasSafeAssignmentTarget(node.parent) ||
          !hasSafeConditionalObject(node.argument)
        ) return

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
function hasSafeConditionalObject (node) {
  if (node.type === 'ConditionalExpression') {
    const { alternate, consequent } = node
    const hasObject = consequent.type === 'ObjectExpression' || alternate.type === 'ObjectExpression'

    return hasObject && hasSafeObjectProperties(consequent) && hasSafeObjectProperties(alternate)
  }

  return node.type === 'LogicalExpression' &&
    node.operator === '&&' &&
    node.right.type === 'ObjectExpression' &&
    hasSafeObjectProperties(node.right)
}

/**
 * @param {import('estree').Expression} node
 * @returns {boolean}
 */
function hasSafeObjectProperties (node) {
  if (node.type !== 'ObjectExpression') return true

  for (const property of node.properties) {
    if (
      property.type !== 'Property' ||
      property.computed ||
      property.kind !== 'init' ||
      property.method ||
      hasProtoKey(property)
    ) return false
  }

  return true
}

/**
 * @param {import('estree').ObjectExpression} node
 * @returns {boolean}
 */
function hasSafeAssignmentTarget (node) {
  for (const property of node.properties) {
    if (property.type !== 'Property') continue
    if (property.kind !== 'init' || isPrototypeSetter(property)) return false
  }

  return true
}

/**
 * @param {import('estree').Property} property
 * @returns {boolean}
 */
function hasProtoKey (property) {
  return !property.computed && (
    (property.key.type === 'Identifier' && property.key.name === '__proto__') ||
    (property.key.type === 'Literal' && property.key.value === '__proto__')
  )
}

/**
 * @param {import('estree').Property} property
 * @returns {boolean}
 */
function isPrototypeSetter (property) {
  return !property.method && !property.shorthand && hasProtoKey(property)
}
