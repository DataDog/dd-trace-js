/**
 * @param {import('estree').Node} node
 * @returns {string | undefined}
 */
function getValueKey (node) {
  if (node.type === 'ChainExpression') {
    return getValueKey(node.expression)
  }

  if (node.type === 'Identifier') {
    return node.name
  }

  if (node.type !== 'MemberExpression' || node.computed || node.property.type !== 'Identifier') {
    return undefined
  }

  const objectKey = getValueKey(node.object)
  return objectKey && `${objectKey}.${node.property.name}`
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
    return node.callee.type === 'Identifier' && node.callee.name === 'FakeAgent'
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

    if (!isTeardownHook(currentNode.parent) || currentNode.parent.arguments[0] !== currentNode) {
      return undefined
    }

    return /** @type {import('estree').FunctionExpression | import('estree').ArrowFunctionExpression} */ (currentNode)
  }
}

/**
 * @param {import('estree').Node} node
 * @param {import('estree').FunctionExpression | import('estree').ArrowFunctionExpression} callback
 * @returns {boolean}
 */
function isSettled (node, callback) {
  let currentNode = node
  while (currentNode.parent) {
    const parentNode = currentNode.parent
    if (parentNode === callback) {
      return callback.expression
    }

    if (parentNode.type === 'AwaitExpression' || parentNode.type === 'ReturnStatement') {
      return true
    }

    if (isFunction(parentNode)) {
      return false
    }

    currentNode = parentNode
  }

  return false
}

/**
 * @param {import('estree').CallExpression} node
 * @returns {string | undefined}
 */
function getAssignedValueKey (node) {
  let currentNode = node
  let parentNode = node.parent
  while (parentNode.type === 'ChainExpression') {
    currentNode = parentNode
    parentNode = parentNode.parent
  }

  if (parentNode.type === 'VariableDeclarator' && parentNode.init === currentNode) {
    return getValueKey(parentNode.id)
  }

  if (parentNode.type === 'AssignmentExpression' && parentNode.right === currentNode) {
    return getValueKey(parentNode.left)
  }
}

/**
 * @param {import('estree').FunctionExpression | import('estree').ArrowFunctionExpression} callback
 * @param {string} valueKey
 * @returns {string}
 */
function getScopedValueKey (callback, valueKey) {
  return `${callback.range[0]}:${valueKey}`
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

  create (context) {
    const fakeAgentValues = new Set()
    const settledValues = new Set()
    const stopCalls = []

    return {
      VariableDeclarator (node) {
        const valueKey = getValueKey(node.id)
        if (valueKey && node.init && isFakeAgent(node.init)) {
          fakeAgentValues.add(valueKey)
        }
      },
      AssignmentExpression (node) {
        const valueKey = getValueKey(node.left)
        if (valueKey && isFakeAgent(node.right)) {
          fakeAgentValues.add(valueKey)
        }
      },
      Identifier (node) {
        const callback = getTeardownCallback(node)
        if (callback && isSettled(node, callback)) {
          settledValues.add(getScopedValueKey(callback, node.name))
        }
      },
      MemberExpression (node) {
        const callback = getTeardownCallback(node)
        const valueKey = getValueKey(node)
        if (callback && valueKey && isSettled(node, callback)) {
          settledValues.add(getScopedValueKey(callback, valueKey))
        }
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
        const valueKey = getValueKey(node.callee.object)
        if (callback && valueKey) {
          stopCalls.push({ callback, node, valueKey })
        }
      },
      'Program:exit' () {
        for (const { callback, node, valueKey } of stopCalls) {
          if (!fakeAgentValues.has(valueKey) || isSettled(node, callback)) continue

          const assignedValueKey = getAssignedValueKey(node)
          if (assignedValueKey && settledValues.has(getScopedValueKey(callback, assignedValueKey))) continue

          context.report({
            node,
            messageId: 'requireSettledStop',
          })
        }
      },
    }
  },
}
