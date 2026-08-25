const FAKE_AGENT_CONSTRUCTORS = new Set(['FakeAgent', 'FakeCiVisIntake'])
const PROMISE_ADOPTERS = new Set(['resolve'])
const PROMISE_AGGREGATES = new Set(['all', 'allSettled'])
const PROMISE_CHAIN_METHODS = new Set(['catch', 'finally', 'then'])

/**
 * @typedef {
 *   import('estree').FunctionDeclaration |
 *   import('estree').FunctionExpression |
 *   import('estree').ArrowFunctionExpression
 * } TeardownCallback
 */

/**
 * @typedef {object} ValueReference
 * @property {import('eslint').Scope.Variable} variable
 * @property {string} memberPath
 */

/** @typedef {Map<import('eslint').Scope.Variable, Set<string>>} ValueReferences */

/**
 * @typedef {object} AssignedValueReference
 * @property {ValueReference} valueReference
 * @property {import('estree').VariableDeclarator | import('estree').AssignmentExpression} assignment
 */

/**
 * @typedef {object} FlowEvent
 * @property {'settle' | 'write'} type
 * @property {ValueReference} valueReference
 * @property {import('estree').Node} node
 * @property {number} position
 */

/**
 * @typedef {object} CodePathState
 * @property {CodePathState | undefined} upper
 * @property {Set<import('eslint').Rule.CodePathSegment>} currentSegments
 */

/**
 * @typedef {object} StopCall
 * @property {TeardownCallback} callback
 * @property {import('estree').CallExpression} node
 * @property {ValueReference} valueReference
 * @property {Set<import('eslint').Rule.CodePathSegment>} segments
 */

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
 * @param {ValueReference} left
 * @param {ValueReference} right
 * @returns {boolean}
 */
function isSameValueReference (left, right) {
  return left.variable === right.variable && left.memberPath === right.memberPath
}

/**
 * @param {ValueReference} write
 * @param {ValueReference} value
 * @returns {boolean}
 */
function writesValueReference (write, value) {
  return write.variable === value.variable &&
    (write.memberPath === value.memberPath ||
      write.memberPath === '' ||
      value.memberPath.startsWith(`${write.memberPath}.`))
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
 * @returns {TeardownCallback | undefined}
 */
function getEnclosingCallback (node) {
  let currentNode = node
  while (currentNode.parent) {
    currentNode = currentNode.parent
    if (!isFunction(currentNode)) continue

    return /** @type {TeardownCallback} */ (currentNode)
  }
}

/**
 * @param {import('estree').Node} node
 * @param {import('eslint').SourceCode} sourceCode
 * @param {Set<import('eslint').Scope.Variable>} [seen]
 * @returns {TeardownCallback | undefined}
 */
function resolveCallback (node, sourceCode, seen = new Set()) {
  if (isFunction(node)) {
    return /** @type {TeardownCallback} */ (node)
  }

  if (node.type !== 'Identifier') return undefined

  const variable = getVariable(node, sourceCode)
  if (!variable || seen.has(variable)) return undefined

  for (const reference of variable.references) {
    if (reference.isWrite() && !reference.init) return undefined
  }

  seen.add(variable)
  if (variable.defs.length !== 1) return undefined

  const [definition] = variable.defs
  if (isFunction(definition.node)) {
    return /** @type {TeardownCallback} */ (definition.node)
  }
  if (definition.node.type === 'VariableDeclarator' && definition.node.init) {
    return resolveCallback(definition.node.init, sourceCode, seen)
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
 * @returns {AssignedValueReference | undefined}
 */
function getAssignedValueReference (node, sourceCode) {
  let currentNode = node
  while (currentNode.parent) {
    const parentNode = currentNode.parent

    if (parentNode.type === 'VariableDeclarator' && parentNode.init === currentNode) {
      const valueReference = getValueReference(parentNode.id, sourceCode)
      return valueReference && { valueReference, assignment: parentNode }
    }

    if (parentNode.type === 'AssignmentExpression' && parentNode.right === currentNode) {
      const valueReference = getValueReference(parentNode.left, sourceCode)
      return valueReference && { valueReference, assignment: parentNode }
    }

    const resultParent = getResultParent(currentNode)
    if (!resultParent) return undefined

    currentNode = resultParent
  }
}

/**
 * @param {Map<import('eslint').Rule.CodePathSegment, FlowEvent[]>} events
 * @param {import('eslint').Rule.CodePathSegment} segment
 * @returns {FlowEvent[]}
 */
function getFlowEvents (events, segment) {
  return events.get(segment) ?? []
}

/**
 * @param {StopCall} stopCall
 * @param {AssignedValueReference} assignedValue
 * @param {Map<import('eslint').Rule.CodePathSegment, FlowEvent[]>} events
 * @returns {boolean}
 */
function isAssignedValueSettled (stopCall, assignedValue, events) {
  const { assignment, valueReference } = assignedValue

  /**
   * @param {import('eslint').Rule.CodePathSegment} segment
   * @param {boolean} initial
   * @param {boolean} skipSourceWrite
   * @param {Map<import('eslint').Rule.CodePathSegment, number>} visiting
   * @param {Map<import('eslint').Rule.CodePathSegment, Map<number, boolean>>} memo
   * @returns {boolean}
   */
  function settlesOnEveryPath (segment, initial, skipSourceWrite, visiting, memo) {
    const state = (initial ? 2 : 0) | (skipSourceWrite ? 1 : 0)
    const segmentMemo = memo.get(segment)
    if (segmentMemo?.has(state)) return segmentMemo.get(state)

    const visitingState = visiting.get(segment) ?? 0
    if ((visitingState & (1 << state)) !== 0) return true
    visiting.set(segment, visitingState | (1 << state))

    /** @type {boolean | undefined} */
    let settled
    for (const event of getFlowEvents(events, segment)) {
      if (initial && event.position <= stopCall.node.range[1]) continue

      if (event.type === 'settle' && isSameValueReference(event.valueReference, valueReference)) {
        settled = true
        break
      }

      if (event.type === 'write' && writesValueReference(event.valueReference, valueReference)) {
        if (skipSourceWrite && event.node === assignment) {
          skipSourceWrite = false
          continue
        }
        settled = false
        break
      }
    }

    if (settled === undefined) {
      let hasNextSegment = false
      settled = true
      for (const nextSegment of segment.nextSegments) {
        hasNextSegment = true
        if (!settlesOnEveryPath(nextSegment, false, skipSourceWrite, visiting, memo)) {
          settled = false
          break
        }
      }
      if (!hasNextSegment) settled = false
    }

    visiting.set(segment, visiting.get(segment) & ~(1 << state))
    let mutableSegmentMemo = segmentMemo
    if (!mutableSegmentMemo) {
      mutableSegmentMemo = new Map()
      memo.set(segment, mutableSegmentMemo)
    }
    mutableSegmentMemo.set(state, settled)
    return settled
  }

  for (const segment of stopCall.segments) {
    if (!settlesOnEveryPath(segment, true, true, new Map(), new Map())) return false
  }
  return stopCall.segments.size > 0
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
    const flowEvents = new Map()
    const stopCalls = []
    const teardownCallbacks = new Set()
    /** @type {CodePathState | undefined} */
    let codePathState

    /**
     * @param {import('estree').Node} node
     * @param {'settle' | 'write'} type
     * @param {ValueReference} valueReference
     */
    function recordFlowEvent (node, type, valueReference) {
      const currentSegments = /** @type {CodePathState} */ (codePathState).currentSegments

      for (const segment of currentSegments) {
        let events = flowEvents.get(segment)
        if (!events) {
          events = []
          flowEvents.set(segment, events)
        }
        events.push({ type, valueReference, node, position: node.range[1] })
      }
    }

    /**
     * @param {import('estree').Node} node
     */
    function recordSettledValue (node) {
      const callback = getEnclosingCallback(node)
      if (!callback || !isSettled(node, callback)) return

      const valueReference = getValueReference(node, sourceCode)
      if (valueReference) {
        recordFlowEvent(node, 'settle', valueReference)
      }
    }

    return {
      onCodePathStart () {
        codePathState = {
          upper: codePathState,
          currentSegments: new Set(),
        }
      },
      onCodePathEnd () {
        codePathState = codePathState?.upper
      },
      /**
       * @param {import('eslint').Rule.CodePathSegment} segment
       */
      onCodePathSegmentStart (segment) {
        codePathState?.currentSegments.add(segment)
      },
      /**
       * @param {import('eslint').Rule.CodePathSegment} segment
       */
      onCodePathSegmentEnd (segment) {
        codePathState?.currentSegments.delete(segment)
      },
      /**
       * @param {import('estree').VariableDeclarator} node
       */
      VariableDeclarator (node) {
        const valueReference = getValueReference(node.id, sourceCode)
        if (valueReference && node.init && isFakeAgent(node.init)) {
          addValueReference(fakeAgentValues, valueReference)
        }
      },
      /**
       * @param {import('estree').VariableDeclarator} node
       */
      'VariableDeclarator:exit' (node) {
        if (!node.init) return

        const valueReference = getValueReference(node.id, sourceCode)
        if (valueReference) {
          recordFlowEvent(node, 'write', valueReference)
        }
      },
      /**
       * @param {import('estree').AssignmentExpression} node
       */
      AssignmentExpression (node) {
        const valueReference = getValueReference(node.left, sourceCode)
        if (valueReference && isFakeAgent(node.right)) {
          addValueReference(fakeAgentValues, valueReference)
        }
      },
      /**
       * @param {import('estree').AssignmentExpression} node
       */
      'AssignmentExpression:exit' (node) {
        const valueReference = getValueReference(node.left, sourceCode)
        if (valueReference) {
          recordFlowEvent(node, 'write', valueReference)
        }
      },
      /**
       * @param {import('estree').Identifier} node
       */
      Identifier (node) {
        if (
          node.parent.type === 'MemberExpression' &&
          node.parent.property === node &&
          !node.parent.computed
        ) return

        recordSettledValue(node)
      },
      /**
       * @param {import('estree').MemberExpression} node
       */
      MemberExpression (node) {
        recordSettledValue(node)
      },
      /**
       * @param {import('estree').CallExpression} node
       */
      'CallExpression:exit' (node) {
        if (isTeardownHook(node)) {
          const callbackNode = node.arguments[node.arguments.length - 1]
          if (callbackNode && callbackNode.type !== 'SpreadElement') {
            const callback = resolveCallback(callbackNode, sourceCode)
            if (callback) teardownCallbacks.add(callback)
          }
        }

        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.computed ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'stop'
        ) {
          return
        }

        const callback = getEnclosingCallback(node)
        const valueReference = getValueReference(node.callee.object, sourceCode)
        if (callback && valueReference && codePathState) {
          stopCalls.push({
            callback,
            node,
            valueReference,
            segments: new Set(codePathState.currentSegments),
          })
        }
      },
      'Program:exit' () {
        for (const events of flowEvents.values()) {
          events.sort((left, right) => left.position - right.position)
        }

        for (const stopCall of stopCalls) {
          const { callback, node, valueReference } = stopCall
          if (!teardownCallbacks.has(callback)) continue
          if (!hasValueReference(fakeAgentValues, valueReference) || isSettled(node, callback)) continue

          const assignedValue = getAssignedValueReference(node, sourceCode)
          if (assignedValue && isAssignedValueSettled(stopCall, assignedValue, flowEvents)) continue

          context.report({
            node,
            messageId: 'requireSettledStop',
          })
        }
      },
    }
  },
}
