export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer building strings directly instead of collecting string fragments in an array',
      recommended: true,
    },
    schema: [{
      type: 'object',
      properties: {
        reportLiteralArrayJoins: {
          type: 'boolean',
        },
        reportMapJoinChains: {
          type: 'boolean',
        },
      },
      additionalProperties: false,
    }],
    messages: {
      buildStringDirectly:
        'Build "{{name}}" directly as a string instead of collecting string fragments in an array before joining.',
      buildLiteralStringDirectly:
        'Build this string directly instead of joining an array literal.',
      buildMappedStringDirectly:
        'Build this string directly instead of mapping string fragments into an array before joining.',
    },
  },

  /**
   * @param {import('eslint').Rule.RuleContext} context
   */
  create (context) {
    const { sourceCode } = context
    const [{ reportLiteralArrayJoins = false, reportMapJoinChains = false } = {}] = context.options
    const arrayAppenders = new Set()
    const arrayDeclarators = []

    return {
      /**
       * @param {import('estree').FunctionDeclaration} node
       */
      FunctionDeclaration (node) {
        const variable = getArrayAppenderVariable(node, sourceCode)
        if (variable) arrayAppenders.add(variable)
      },

      /**
       * @param {import('estree').VariableDeclarator} node
       */
      VariableDeclarator (node) {
        arrayDeclarators.push(node)
      },

      'Program:exit' () {
        for (const node of arrayDeclarators) {
          reportUnnecessaryArrayJoin(node, sourceCode, arrayAppenders, context)
        }
      },

      /**
       * @param {import('estree').CallExpression} node
       */
      CallExpression (node) {
        if (reportLiteralArrayJoins && isLiteralJoin(node, sourceCode)) {
          context.report({
            node,
            messageId: 'buildLiteralStringDirectly',
          })
        }

        if (reportMapJoinChains && isMapJoin(node)) {
          context.report({
            node,
            messageId: 'buildMappedStringDirectly',
          })
        }
      },
    }
  },
}

/**
 * @param {import('estree').VariableDeclarator} node
 * @param {import('eslint').SourceCode} sourceCode
 * @param {Set<import('eslint').Scope.Variable>} arrayAppenders
 * @param {import('eslint').Rule.RuleContext} context
 */
function reportUnnecessaryArrayJoin (node, sourceCode, arrayAppenders, context) {
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

    const appendCall = getArrayAppenderCall(identifier, sourceCode, arrayAppenders)
    if (appendCall) {
      pushCalls.push(appendCall)
      continue
    }

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
}

/**
 * @param {import('estree').FunctionDeclaration} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {import('eslint').Scope.Variable | undefined}
 */
function getArrayAppenderVariable (node, sourceCode) {
  const [arrayParameter] = node.params
  if (node.async || node.generator || node.id === null || arrayParameter?.type !== 'Identifier') return

  const variables = sourceCode.getDeclaredVariables(node)
  const arrayVariable = variables.find(variable => variable.identifiers.includes(arrayParameter))
  const functionVariable = variables.find(variable => variable.identifiers.includes(node.id))
  if (!arrayVariable || !functionVariable || arrayVariable.references.length === 0) return

  for (const reference of arrayVariable.references) {
    const identifier = reference.identifier
    const member = identifier.parent
    if (
      member.type !== 'MemberExpression' ||
      member.object !== identifier ||
      member.computed ||
      member.optional ||
      member.property.type !== 'Identifier' ||
      member.property.name !== 'push'
    ) {
      return
    }

    const call = member.parent
    if (
      call.type !== 'CallExpression' ||
      call.callee !== member ||
      call.optional ||
      call.parent.type !== 'ExpressionStatement' ||
      call.arguments.length === 0 ||
      call.arguments.some(argument =>
        argument.type === 'SpreadElement' || isKnownNonStringExpression(argument, sourceCode))
    ) {
      return
    }
  }

  return functionVariable
}

/**
 * @param {import('estree').Identifier} identifier
 * @param {import('eslint').SourceCode} sourceCode
 * @param {Set<import('eslint').Scope.Variable>} arrayAppenders
 * @returns {import('estree').CallExpression | undefined}
 */
function getArrayAppenderCall (identifier, sourceCode, arrayAppenders) {
  const call = identifier.parent
  if (
    call.type !== 'CallExpression' ||
    call.optional ||
    call.arguments[0] !== identifier ||
    call.callee.type !== 'Identifier' ||
    call.parent.type !== 'ExpressionStatement'
  ) {
    return
  }

  const reference = sourceCode.getScope(call.callee).references
    .find(candidate => candidate.identifier === call.callee)
  if (!reference || !arrayAppenders.has(reference.resolved)) return

  return call
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

/**
 * @param {import('estree').CallExpression} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {boolean}
 */
function isLiteralJoin (node, sourceCode) {
  if (
    node.optional ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.callee.optional ||
    node.callee.property.type !== 'Identifier' ||
    node.callee.property.name !== 'join' ||
    node.arguments.length > 1 ||
    !isStaticSeparator(node.arguments[0])
  ) {
    return false
  }

  const elements = getLiteralJoinElements(node.callee.object, sourceCode)
  if (!elements) return false
  if (elements.some(element => element === null || element.type === 'SpreadElement')) return false

  return elements.length > 0
}

/**
 * @param {import('estree').CallExpression} node
 * @returns {boolean}
 */
function isMapJoin (node) {
  if (
    node.optional ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.callee.optional ||
    node.callee.property.type !== 'Identifier' ||
    node.callee.property.name !== 'join' ||
    node.arguments.length > 1 ||
    !isStaticSeparator(node.arguments[0])
  ) {
    return false
  }

  const mapCall = node.callee.object
  return mapCall.type === 'CallExpression' &&
    !mapCall.optional &&
    mapCall.callee.type === 'MemberExpression' &&
    !mapCall.callee.computed &&
    !mapCall.callee.optional &&
    mapCall.callee.property.type === 'Identifier' &&
    mapCall.callee.property.name === 'map' &&
    mapCall.arguments.length === 1 &&
    mapCall.arguments[0].type !== 'SpreadElement'
}

/**
 * @param {import('estree').Expression} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {(import('estree').Expression | import('estree').SpreadElement | null)[] | undefined}
 */
function getLiteralJoinElements (node, sourceCode) {
  if (node.type === 'ArrayExpression') return node.elements
  if (
    node.type !== 'CallExpression' ||
    node.optional ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.callee.optional ||
    node.callee.property.type !== 'Identifier' ||
    node.callee.property.name !== 'filter' ||
    node.callee.object.type !== 'ArrayExpression' ||
    node.callee.object.elements.length !== 2 ||
    node.arguments.length !== 1 ||
    node.arguments[0].type !== 'Identifier' ||
    node.arguments[0].name !== 'Boolean' ||
    !isGlobalBoolean(node.arguments[0], sourceCode)
  ) {
    return
  }

  return node.callee.object.elements
}

/**
 * @param {import('estree').Identifier} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {boolean}
 */
function isGlobalBoolean (node, sourceCode) {
  let scope = sourceCode.getScope(node)
  while (scope) {
    if (scope.set.get('Boolean')?.defs.length) return false
    scope = scope.upper
  }

  return true
}
