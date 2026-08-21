const FAKE_AGENT_CONSTRUCTORS = new Set(['FakeAgent', 'FakeCiVisIntake'])
const PROMISE_ADOPTERS = new Set(['resolve'])
const PROMISE_AGGREGATES = new Set(['all', 'allSettled'])
const PROMISE_CHAIN_METHODS = new Set(['catch', 'finally', 'then'])

/**
 * @typedef {import('estree').FunctionExpression | import('estree').ArrowFunctionExpression} TeardownCallback
 */

/**
 * @typedef {object} ValueReference
 * @property {import('eslint').Scope.Variable} variable
 * @property {string} memberPath
 */

/** @typedef {Map<import('eslint').Scope.Variable, Set<string>>} ValueReferences */
/** @typedef {Map<TeardownCallback, ValueReferences>} SettledValueReferences */

/**
 * @param {import('estree').Identifier} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {import('eslint').Scope.Variable | undefined}
 */
function getVariable (node, sourceCode) {
  let scope = sourceCode.getScope(node)
  while (scope) {
    const variable = scope.set.get(node.name)
    if (variable) return variable

    scope = scope.upper
  }
}

/**
 * @param {import('estree').Node} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {ValueReference | undefined}
 */
function getValueReference (node, sourceCode) {
  if (node.type === 'ChainExpression') {
    return getValueReference(node.expression, sourceCode)
  }

  if (node.type === 'Identifier') {
    const variable = getVariable(node, sourceCode)
    return variable && { variable, memberPath: '' }
  }

  if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier') {
    return undefined
  }

  const reference = getValueReference(node.object, sourceCode)
  if (reference) {
    reference.memberPath += `.${node.property.name}`
  }
  return reference
}

/**
 * @param {ValueReferences} references
 * @param {ValueReference} reference
 */
function addValueReference (references, reference) {
  let memberPaths = references.get(reference.variable)
  if (!memberPaths) {
    memberPaths = new Set()
    references.set(reference.variable, memberPaths)
  }
  memberPaths.add(reference.memberPath)
}

/**
 * @param {ValueReferences} references
 * @param {ValueReference} reference
 * @returns {boolean}
 */
function hasValueReference (references, reference) {
  return references.get(reference.variable)?.has(reference.memberPath) === true
}

/**
 * @param {SettledValueReferences} references
 * @param {TeardownCallback} callback
 * @param {ValueReference} reference
 */
function addSettledValueReference (references, callback, reference) {
  let callbackReferences = references.get(callback)
  if (!callbackReferences) {
    callbackReferences = new Map()
    references.set(callback, callbackReferences)
  }
  addValueReference(callbackReferences, reference)
}

/**
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isFakeAgent (node) {
  if (node.type === 'AwaitExpression' || node.type === 'ChainExpression') {
    return isFakeAgent(node.argument ?? node.expression)
  }

  if (node.type === 'NewExpression') {
    return node.callee.type === 'Identifier' && FAKE_AGENT_CONSTRUCTORS.has(node.callee.name)
  }

  return node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'start' &&
    isFakeAgent(node.callee.object)
}

/**
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isFunction (node) {
  return node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
}

/**
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isTeardownHook (node) {
  return node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    (node.callee.name === 'after' || node.callee.name === 'afterEach')
}

/**
 * @param {import('estree').Node} node
 * @returns {import('estree').FunctionExpression | import('estree').ArrowFunctionExpression | undefined}
 */
function getTeardownCallback (node) {
  let currentNode = node
  while (currentNode.parent) {
    currentNode = currentNode.parent
    if (!isFunction(currentNode)) continue

    if (
      !isTeardownHook(currentNode.parent) ||
      currentNode.parent.arguments[currentNode.parent.arguments.length - 1] !== currentNode
    ) {
      return undefined
    }

    return /** @type {import('estree').FunctionExpression | import('estree').ArrowFunctionExpression} */ (currentNode)
  }
}

/**
 * @param {import('estree').CallExpression} node
 * @param {Set<string>} methodNames
 * @param {import('estree').Node} argument
 * @returns {boolean}
 */
function isPromiseStaticCall (node, methodNames, argument) {
  return node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Promise' &&
    node.callee.property.type === 'Identifier' &&
    methodNames.has(node.callee.property.name) &&
    node.arguments[0] === argument
}

/**
 * @param {import('estree').Node} node
 * @returns {import('estree').Node | undefined}
 */
function getResultParent (node) {
  const parentNode = node.parent
  if (parentNode.type === 'ChainExpression' && parentNode.expression === node) {
    return parentNode
  }

  if (
    parentNode.type === 'ConditionalExpression' &&
    (parentNode.consequent === node || parentNode.alternate === node)
  ) {
    return parentNode
  }

  if (parentNode.type === 'LogicalExpression') {
    if (parentNode.right === node || (parentNode.left === node && parentNode.operator !== '&&')) {
      return parentNode
    }
    return undefined
  }

  if (
    parentNode.type === 'SequenceExpression' &&
    parentNode.expressions[parentNode.expressions.length - 1] === node
  ) {
    return parentNode
  }

  if (parentNode.type === 'AssignmentExpression' && parentNode.right === node) {
    return parentNode
  }

  if (parentNode.type === 'ArrayExpression' && parentNode.elements.includes(node)) {
    const callNode = parentNode.parent
    if (callNode.type === 'CallExpression' && isPromiseStaticCall(callNode, PROMISE_AGGREGATES, parentNode)) {
      return callNode
    }
    return undefined
  }

  if (
    parentNode.type === 'CallExpression' &&
    isPromiseStaticCall(parentNode, PROMISE_ADOPTERS, node)
  ) {
    return parentNode
  }

  if (
    parentNode.type === 'MemberExpression' &&
    parentNode.object === node &&
    !parentNode.computed &&
    parentNode.property.type === 'Identifier' &&
    PROMISE_CHAIN_METHODS.has(parentNode.property.name) &&
    parentNode.parent.type === 'CallExpression' &&
    parentNode.parent.callee === parentNode
  ) {
    return parentNode.parent
  }
}

/**
 * @param {import('estree').Node} node
 * @param {TeardownCallback} callback
 * @returns {boolean}
 */
function isSettled (node, callback) {
  let currentNode = node
  while (currentNode.parent !== callback) {
    const parentNode = currentNode.parent
    if (
      (parentNode.type === 'AwaitExpression' || parentNode.type === 'ReturnStatement') &&
      parentNode.argument === currentNode
    ) {
      return true
    }

    const resultParent = getResultParent(currentNode)
    if (!resultParent) return false

    currentNode = resultParent
  }

  return callback.expression && callback.body === currentNode
}

/**
 * @param {import('estree').CallExpression} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {ValueReference | undefined}
 */
function getAssignedValueReference (node, sourceCode) {
  let currentNode = node
  while (currentNode.parent) {
    const parentNode = currentNode.parent

    if (parentNode.type === 'VariableDeclarator' && parentNode.init === currentNode) {
      return getValueReference(parentNode.id, sourceCode)
    }

    if (parentNode.type === 'AssignmentExpression' && parentNode.right === currentNode) {
      return getValueReference(parentNode.left, sourceCode)
    }

    const resultParent = getResultParent(currentNode)
    if (!resultParent) return undefined

    currentNode = resultParent
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require fake-agent teardown hooks to settle stop promises.',
    },
    schema: [],
    messages: {
      requireSettledStop: 'FakeAgent.stop() must be awaited or returned from a Mocha teardown hook.',
    },
  },

  /**
   * @param {import('eslint').Rule.RuleContext} context
   * @returns {import('eslint').Rule.RuleListener}
   */
  create (context) {
    const { sourceCode } = context
    const fakeAgentValues = new Map()
    const settledValues = new Map()
    const stopCalls = []

    /**
     * @param {import('estree').Node} node
     */
    function recordSettledValue (node) {
      const callback = getTeardownCallback(node)
      if (!callback || !isSettled(node, callback)) return

      const valueReference = getValueReference(node, sourceCode)
      if (valueReference) {
        addSettledValueReference(settledValues, callback, valueReference)
      }
    }

    return {
      VariableDeclarator (node) {
        const valueReference = getValueReference(node.id, sourceCode)
        if (valueReference && node.init && isFakeAgent(node.init)) {
          addValueReference(fakeAgentValues, valueReference)
        }
      },
      AssignmentExpression (node) {
        const valueReference = getValueReference(node.left, sourceCode)
        if (valueReference && isFakeAgent(node.right)) {
          addValueReference(fakeAgentValues, valueReference)
        }
      },
      Identifier (node) {
        if (
          node.parent.type === 'MemberExpression' &&
          node.parent.property === node &&
          !node.parent.computed
        ) return

        recordSettledValue(node)
      },
      MemberExpression (node) {
        recordSettledValue(node)
      },
      CallExpression (node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.computed ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'stop'
        ) {
          return
        }

        const callback = getTeardownCallback(node)
        const valueReference = getValueReference(node.callee.object, sourceCode)
        if (callback && valueReference) {
          stopCalls.push({ callback, node, valueReference })
        }
      },
      'Program:exit' () {
        for (const { callback, node, valueReference } of stopCalls) {
          if (!hasValueReference(fakeAgentValues, valueReference) || isSettled(node, callback)) continue

          const assignedValueReference = getAssignedValueReference(node, sourceCode)
          const callbackReferences = settledValues.get(callback)
          if (
            assignedValueReference &&
            callbackReferences &&
            hasValueReference(callbackReferences, assignedValueReference)
          ) continue

          context.report({
            node,
            messageId: 'requireSettledStop',
          })
        }
      },
    }
  },
}
