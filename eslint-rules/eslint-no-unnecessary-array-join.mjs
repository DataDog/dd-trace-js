export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer building strings directly instead of collecting string fragments in an array',
      recommended: true,
    },
    schema: [],
    messages: {
      buildStringDirectly:
        'Build "{{name}}" directly as a string instead of collecting string fragments in an array before joining.',
    },
  },

  /**
   * @param {import('eslint').Rule.RuleContext} context
   */
  create (context) {
    const { sourceCode } = context

    return {
      /**
       * @param {import('estree').VariableDeclarator} node
       */
      VariableDeclarator (node) {
        if (
          node.id.type !== 'Identifier' ||
          node.init?.type !== 'ArrayExpression' ||
          node.init.elements.length !== 0
        ) {
          return
        }

        const [variable] = sourceCode.getDeclaredVariables(node)
        if (variable.defs.length !== 1) return

        const owner = getFunctionOwner(node)
        let joinCall
        const pushCalls = []

        for (const reference of variable.references) {
          const identifier = reference.identifier
          if (identifier === node.id) continue
          if (getFunctionOwner(identifier) !== owner) return

          const member = identifier.parent
          if (
            member.type !== 'MemberExpression' ||
            member.object !== identifier ||
            member.computed ||
            member.optional ||
            member.property.type !== 'Identifier'
          ) {
            return
          }

          const call = member.parent
          if (call.type !== 'CallExpression' || call.callee !== member || call.optional) return

          if (member.property.name === 'push') {
            if (
              call.parent.type !== 'ExpressionStatement' ||
              call.arguments.length === 0 ||
              call.arguments.some(argument =>
                argument.type === 'SpreadElement' || isKnownNonStringExpression(argument, sourceCode))
            ) {
              return
            }

            pushCalls.push(call)
            continue
          }

          if (member.property.name === 'join') {
            if (
              joinCall ||
              call.arguments.length > 1 ||
              !isStaticSeparator(call.arguments[0])
            ) {
              return
            }

            joinCall = call
            continue
          }

          return
        }

        if (!joinCall || pushCalls.length === 0) return
        for (const pushCall of pushCalls) {
          if (pushCall.range[0] > joinCall.range[0]) return
        }

        context.report({
          node: joinCall,
          messageId: 'buildStringDirectly',
          data: { name: node.id.name },
        })
      },
    }
  },
}

/**
 * @param {import('estree').Node} node
 */
function getFunctionOwner (node) {
  let current = node.parent

  while (current && current.type !== 'Program') {
    if (
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression'
    ) {
      return current
    }

    current = current.parent
  }

  return current
}

/**
 * @param {import('estree').Expression | import('estree').SpreadElement | undefined} node
 * @returns {boolean}
 */
function isStaticSeparator (node) {
  if (node === undefined) return true
  if (node.type === 'Literal') return typeof node.value === 'string'
  return node.type === 'TemplateLiteral' && node.expressions.length === 0
}

/**
 * @param {import('estree').Expression} node
 * @param {import('eslint').SourceCode} sourceCode
 * @param {Set<import('estree').Node>} [seen]
 * @returns {boolean}
 */
function isKnownNonStringExpression (node, sourceCode, seen = new Set()) {
  if (node.type === 'Literal') return typeof node.value !== 'string'

  if (node.type === 'BinaryExpression') {
    return node.operator !== '+'
  }

  if (node.type === 'ConditionalExpression') {
    return isKnownNonStringExpression(node.consequent, sourceCode, seen) ||
      isKnownNonStringExpression(node.alternate, sourceCode, seen)
  }

  if (node.type === 'LogicalExpression') {
    return isKnownNonStringExpression(node.left, sourceCode, seen) ||
      isKnownNonStringExpression(node.right, sourceCode, seen)
  }

  if (node.type === 'SequenceExpression') {
    return isKnownNonStringExpression(node.expressions[node.expressions.length - 1], sourceCode, seen)
  }

  if (node.type === 'UnaryExpression') return node.operator !== 'typeof'
  if (node.type === 'UpdateExpression') return true

  if (
    node.type === 'ArrayExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'NewExpression' ||
    node.type === 'ObjectExpression'
  ) {
    return true
  }

  if (node.type === 'Identifier' && !seen.has(node)) {
    seen.add(node)
    let scope = sourceCode.getScope(node)

    while (scope) {
      const variable = scope.set.get(node.name)
      const definition = variable?.defs.find(definition =>
        definition.type === 'Variable' &&
        definition.node.init &&
        definition.node.parent.kind === 'const'
      )

      if (definition) return isKnownNonStringExpression(definition.node.init, sourceCode, seen)
      if (variable) return node.name === 'undefined' && variable.defs.length === 0
      scope = scope.upper
    }

    return node.name === 'undefined'
  }

  return false
}
