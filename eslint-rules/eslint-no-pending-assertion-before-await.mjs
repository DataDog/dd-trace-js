const DEFAULT_PROMISE_METHODS = [
  'assertFirstTraceSpan',
  'assertNoTraces',
  'assertSomeTraces',
  'expectPipelineStats',
]

const PROMISE_COMBINATORS = new Set(['all', 'any', 'race', 'resolve'])
const PROMISE_SETTLERS = new Set(['allSettled'])
const RECEIVER_SETTLERS = new Set(['close', 'reset'])
const SAFE_PROMISE_SINKS = new Set(['doesNotReject', 'rejects'])

/** @typedef {import('eslint').Rule.CodePath} CodePath */
/** @typedef {import('eslint').Rule.CodePathSegment} CodePathSegment */
/** @typedef {import('eslint').Scope.Variable} ScopeVariable */
/** @typedef {Map<PromiseToken, number>} PendingCounts */

/**
 * @typedef {{
 *   method: string,
 *   receiver: object | string,
 * }} PromiseToken
 */

/** @typedef {{ type: 'create', token: PromiseToken }} CreateEvent */
/** @typedef {{ type: 'settle', tokens: Set<PromiseToken> }} SettleEvent */
/** @typedef {{ type: 'settleReceiver', receiver: object | string }} SettleReceiverEvent */
/**
 * @typedef {{
 *   type: 'await',
 *   handled: Set<PromiseToken>,
 *   node: import('estree').AwaitExpression | import('estree').ForOfStatement,
 * }} AwaitEvent
 */
/** @typedef {CreateEvent | SettleEvent | SettleReceiverEvent | AwaitEvent} AnalysisEvent */
/** @typedef {import('estree').CallExpression & { parent: import('eslint').Rule.Node }} CallExpressionWithParent */

/**
 * @typedef {{
 *   codePath: CodePath,
 *   currentSegments: Set<CodePathSegment>,
 *   events: Map<CodePathSegment, AnalysisEvent[]>,
 *   segments: Set<CodePathSegment>,
 * }} CodePathFrame
 */

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require rejection handlers on asynchronous test assertions before another operation is awaited.',
    },
    schema: [{
      type: 'object',
      properties: {
        promiseMethods: {
          type: 'array',
          items: { type: 'string' },
          uniqueItems: true,
        },
      },
      additionalProperties: false,
    }],
    messages: {
      pendingAssertion:
        'The promise returned by `{{method}}()` can reject before this await observes it. ' +
        'Attach a rejection handler first, usually by starting the operation and awaiting both with `Promise.all()`.',
    },
  },

  /**
   * @param {import('eslint').Rule.RuleContext} context
   * @returns {import('eslint').Rule.RuleListener}
   */
  create (context) {
    const sourceCode = context.sourceCode
    const promiseMethods = new Set(context.options[0]?.promiseMethods ?? DEFAULT_PROMISE_METHODS)
    /** @type {WeakMap<import('estree').CallExpression, PromiseToken>} */
    const callTokens = new WeakMap()
    /** @type {Map<ScopeVariable, Set<PromiseToken>>} */
    const variableTokens = new Map()
    /** @type {CodePathFrame[]} */
    const frames = []

    /**
     * This rule deliberately follows only direct const bindings and direct promise-combinator
     * inputs created outside loops. Tracking mutable aliases, promise-containing containers, or
     * repeated instances from one loop callsite without type information creates correlation errors.
     *
     * @returns {CodePathFrame}
     */
    function currentFrame () {
      return /** @type {CodePathFrame} */ (frames.at(-1))
    }

    /**
     * @param {import('estree').Identifier} identifier
     * @returns {ScopeVariable | undefined}
     */
    function resolveVariable (identifier) {
      /** @type {import('eslint').Scope.Scope | null} */
      let scope = sourceCode.getScope(identifier)
      while (scope) {
        const variable = scope.set.get(identifier.name)
        if (variable) return variable
        scope = scope.upper
      }
    }

    /**
     * @param {import('estree').Expression | import('estree').Super} receiver
     * @returns {object | string}
     */
    function getReceiverIdentity (receiver) {
      if (receiver.type === 'Identifier') {
        return resolveVariable(receiver) ?? `identifier:${receiver.name}`
      }
      return sourceCode.getText(receiver)
    }

    /**
     * @param {import('estree').MemberExpression} member
     * @returns {string | undefined}
     */
    function getStaticPropertyName (member) {
      if (!member.computed && member.property.type === 'Identifier') return member.property.name
      if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string') {
        return member.property.value
      }
    }

    /**
     * @param {import('estree').Identifier} identifier
     * @returns {boolean}
     */
    function isNativePromise (identifier) {
      if (identifier.name !== 'Promise') return false
      const variable = resolveVariable(identifier)
      return !variable || variable.defs.length === 0
    }

    /**
     * @param {import('estree').Expression | import('estree').SpreadElement | undefined} handler
     * @param {Set<import('estree').Node>} [seen]
     * @returns {boolean}
     */
    function hasRejectionHandler (handler, seen = new Set()) {
      if (!handler || handler.type === 'SpreadElement' || seen.has(handler)) return false
      seen.add(handler)

      switch (handler.type) {
        case 'ArrowFunctionExpression':
        case 'FunctionExpression':
        case 'CallExpression':
        case 'MemberExpression':
          return true
        case 'Identifier': {
          if (handler.name === 'undefined') return false
          const variable = resolveVariable(handler)
          const definition = variable?.defs.find(definition => definition.type === 'Variable')
          if (!definition || definition.parent.kind !== 'const' || !definition.node.init) return true
          return hasRejectionHandler(definition.node.init, seen)
        }
        case 'ChainExpression':
          return hasRejectionHandler(handler.expression, seen)
        case 'ConditionalExpression':
          return hasRejectionHandler(handler.consequent, seen) &&
            hasRejectionHandler(handler.alternate, seen)
        default:
          return false
      }
    }

    /**
     * @param {AnalysisEvent} event
     * @returns {void}
     */
    function recordEvent (event) {
      for (const segment of currentFrame().currentSegments) {
        const events = currentFrame().events.get(segment) ?? []
        events.push(event)
        currentFrame().events.set(segment, events)
      }
    }

    /**
     * @param {CallExpressionWithParent} node
     * @returns {boolean}
     */
    function hasSupportedOrigin (node) {
      if (isInsideLoop(node)) return false

      const parent = node.parent

      if (
        parent.type === 'VariableDeclarator' &&
        parent.init === node &&
        parent.id.type === 'Identifier' &&
        parent.parent.type === 'VariableDeclaration'
      ) {
        return parent.parent.kind === 'const'
      }

      if (
        (parent.type === 'AwaitExpression' && parent.argument === node) ||
        (parent.type === 'ReturnStatement' && parent.argument === node) ||
        (parent.type === 'ExpressionStatement' && parent.expression === node) ||
        (parent.type === 'MemberExpression' && parent.object === node)
      ) {
        return true
      }

      if (parent.type === 'ArrayExpression') {
        const call = parent.parent
        return call.type === 'CallExpression' &&
          call.arguments.includes(parent) &&
          isPromiseConsumerCall(call)
      }

      return parent.type === 'CallExpression' &&
        parent.arguments.includes(node) &&
        isPromiseConsumerCall(parent)
    }

    /**
     * @param {CallExpressionWithParent} node
     * @returns {boolean}
     */
    function isInsideLoop (node) {
      /** @type {import('eslint').Rule.Node | null} */
      let current = node.parent
      while (current) {
        if (
          current.type === 'ArrowFunctionExpression' ||
          current.type === 'FunctionDeclaration' ||
          current.type === 'FunctionExpression'
        ) {
          return false
        }
        if (
          current.type === 'DoWhileStatement' ||
          current.type === 'ForInStatement' ||
          current.type === 'ForOfStatement' ||
          current.type === 'ForStatement' ||
          current.type === 'WhileStatement'
        ) {
          return true
        }
        current = current.parent
      }
      return false
    }

    /**
     * @param {import('estree').CallExpression} node
     * @returns {boolean}
     */
    function isPromiseConsumerCall (node) {
      if (node.callee.type !== 'MemberExpression') return false
      const method = getStaticPropertyName(node.callee)
      const receiver = node.callee.object
      if (!method || receiver.type === 'Super') return false

      if (receiver.type === 'Identifier' && isNativePromise(receiver)) {
        return PROMISE_COMBINATORS.has(method) || PROMISE_SETTLERS.has(method)
      }

      return receiver.type === 'Identifier' &&
        receiver.name === 'assert' &&
        SAFE_PROMISE_SINKS.has(method)
    }

    /**
     * @param {import('estree').Node | null | undefined} node
     * @param {boolean} mustHandle
     * @returns {Set<PromiseToken>}
     */
    function collectTokens (node, mustHandle = false) {
      if (!node) return new Set()

      if (node.type === 'CallExpression') {
        const directToken = callTokens.get(node)
        if (directToken) return new Set([directToken])
      }

      if (node.type === 'Identifier') {
        const variable = resolveVariable(node)
        return new Set(variable && variableTokens.get(variable))
      }

      if (node.type === 'ConditionalExpression') {
        const branches = [
          collectTokens(node.consequent, mustHandle),
          collectTokens(node.alternate, mustHandle),
        ]
        return mustHandle ? intersectTokenSets(branches) : unionTokenSets(branches)
      }

      if (node.type === 'LogicalExpression') {
        const branches = [
          collectTokens(node.left, mustHandle),
          collectTokens(node.right, mustHandle),
        ]
        return mustHandle ? intersectTokenSets(branches) : unionTokenSets(branches)
      }

      if (node.type === 'SequenceExpression') {
        return collectTokens(node.expressions.at(-1), mustHandle)
      }

      if (node.type === 'ChainExpression') {
        return collectTokens(node.expression, mustHandle)
      }

      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return new Set()

      const method = getStaticPropertyName(node.callee)
      const receiver = node.callee.object
      if (!method || receiver.type === 'Super') return new Set()

      const receiverTokens = collectTokens(receiver, mustHandle)
      if (method === 'catch') {
        return hasRejectionHandler(node.arguments[0]) ? new Set() : receiverTokens
      }
      if (method === 'then') {
        return hasRejectionHandler(node.arguments[1]) ? new Set() : receiverTokens
      }
      if (method === 'finally') return receiverTokens

      if (receiver.type === 'Identifier' && isNativePromise(receiver)) {
        if (PROMISE_SETTLERS.has(method)) return new Set()
        if (PROMISE_COMBINATORS.has(method)) {
          return collectConsumerTokens(node, mustHandle)
        }
      }

      if (
        receiver.type === 'Identifier' &&
        receiver.name === 'assert' &&
        SAFE_PROMISE_SINKS.has(method)
      ) {
        return collectConsumerTokens(node, mustHandle)
      }

      return new Set()
    }

    /**
     * @param {import('estree').CallExpression} node
     * @param {boolean} mustHandle
     * @returns {Set<PromiseToken>}
     */
    function collectConsumerTokens (node, mustHandle) {
      const groups = []

      for (const argument of node.arguments) {
        if (argument.type === 'SpreadElement') continue
        if (argument.type === 'ArrayExpression') {
          for (const element of argument.elements) {
            if (!element || element.type === 'SpreadElement' || element.type === 'ArrayExpression') continue
            groups.push(collectTokens(element, mustHandle))
          }
        } else {
          groups.push(collectTokens(argument, mustHandle))
        }
      }

      return unionTokenSets(groups)
    }

    /**
     * @param {Set<PromiseToken>[]} groups
     * @returns {Set<PromiseToken>}
     */
    function unionTokenSets (groups) {
      const tokens = new Set()
      for (const group of groups) {
        for (const token of group) tokens.add(token)
      }
      return tokens
    }

    /**
     * @param {Set<PromiseToken>[]} groups
     * @returns {Set<PromiseToken>}
     */
    function intersectTokenSets (groups) {
      const [first, ...rest] = groups
      if (!first) return new Set()
      return new Set([...first].filter(token => rest.every(group => group.has(token))))
    }

    /**
     * @param {PendingCounts} pending
     * @param {AnalysisEvent[]} events
     * @param {Set<PromiseToken> | undefined} reported
     * @returns {PendingCounts}
     */
    function applyEvents (pending, events, reported) {
      for (const event of events) {
        if (event.type === 'create') {
          pending.set(event.token, Math.min((pending.get(event.token) ?? 0) + 1, 2))
          continue
        }

        if (event.type === 'settle') {
          for (const token of event.tokens) decrementPendingCount(pending, token)
          continue
        }

        if (event.type === 'settleReceiver') {
          for (const token of pending.keys()) {
            if (token.receiver === event.receiver) pending.delete(token)
          }
          continue
        }

        for (const token of event.handled) decrementPendingCount(pending, token)
        for (const token of pending.keys()) {
          if (reported && !reported.has(token)) {
            context.report({
              node: event.node,
              messageId: 'pendingAssertion',
              data: { method: token.method },
            })
            reported.add(token)
          }
          pending.delete(token)
        }
      }
      return pending
    }

    /**
     * @param {PendingCounts} pending
     * @param {PromiseToken} token
     * @returns {void}
     */
    function decrementPendingCount (pending, token) {
      const count = pending.get(token) ?? 0
      if (count <= 1) {
        pending.delete(token)
      } else {
        pending.set(token, count - 1)
      }
    }

    /**
     * @param {PendingCounts[]} states
     * @returns {PendingCounts}
     */
    function mergePendingCounts (states) {
      const merged = new Map()
      for (const state of states) {
        for (const [token, count] of state) {
          merged.set(token, Math.max(merged.get(token) ?? 0, count))
        }
      }
      return merged
    }

    /**
     * @param {PendingCounts} left
     * @param {PendingCounts} right
     * @returns {boolean}
     */
    function pendingCountsEqual (left, right) {
      if (left.size !== right.size) return false
      return [...left].every(([token, count]) => right.get(token) === count)
    }

    /**
     * @param {CodePathFrame} frame
     * @param {Map<CodePathSegment, PendingCounts>} outputStates
     * @param {CodePathSegment} segment
     * @returns {PendingCounts}
     */
    function getInputState (frame, outputStates, segment) {
      const predecessorStates = segment.prevSegments
        .filter(predecessor => frame.segments.has(predecessor))
        .map(predecessor => outputStates.get(predecessor) ?? new Map())
      if (segment === frame.codePath.initialSegment || predecessorStates.length === 0) {
        predecessorStates.push(new Map())
      }
      return mergePendingCounts(predecessorStates)
    }

    /**
     * @param {CodePathFrame} frame
     * @returns {void}
     */
    function analyzeCodePath (frame) {
      const segments = [...frame.segments]
      /** @type {Map<CodePathSegment, PendingCounts>} */
      const outputStates = new Map()
      let changed

      do {
        changed = false
        for (const segment of segments) {
          const outputState = applyEvents(
            getInputState(frame, outputStates, segment),
            frame.events.get(segment) ?? [],
            undefined
          )
          const previousOutput = outputStates.get(segment)
          if (!previousOutput || !pendingCountsEqual(previousOutput, outputState)) {
            outputStates.set(segment, outputState)
            changed = true
          }
        }
      } while (changed)

      const reported = new Set()
      for (const segment of segments) {
        applyEvents(
          getInputState(frame, outputStates, segment),
          frame.events.get(segment) ?? [],
          reported
        )
      }
    }

    return {
      onCodePathStart (codePath) {
        frames.push({
          codePath,
          currentSegments: new Set(),
          events: new Map(),
          segments: new Set(),
        })
      },

      onCodePathEnd () {
        analyzeCodePath(currentFrame())
        frames.pop()
      },

      onCodePathSegmentStart (segment) {
        currentFrame().segments.add(segment)
        currentFrame().currentSegments.add(segment)
      },

      onCodePathSegmentEnd (segment) {
        currentFrame().currentSegments.delete(segment)
      },

      'CallExpression:exit' (node) {
        if (node.callee.type !== 'MemberExpression') return

        const method = getStaticPropertyName(node.callee)
        const receiver = node.callee.object
        if (!method || receiver.type === 'Super') return

        if (promiseMethods.has(method) && hasSupportedOrigin(node)) {
          const token = {
            method,
            receiver: getReceiverIdentity(receiver),
          }
          callTokens.set(node, token)
          recordEvent({ type: 'create', token })
          return
        }

        if (
          (method === 'catch' && hasRejectionHandler(node.arguments[0])) ||
          (method === 'then' && hasRejectionHandler(node.arguments[1])) ||
          method === 'cancel'
        ) {
          recordEvent({
            type: 'settle',
            tokens: collectTokens(receiver, true),
          })
          return
        }

        if (RECEIVER_SETTLERS.has(method)) {
          recordEvent({
            type: 'settleReceiver',
            receiver: getReceiverIdentity(receiver),
          })
          return
        }

        if (
          receiver.type === 'Identifier' &&
          isNativePromise(receiver) &&
          PROMISE_SETTLERS.has(method)
        ) {
          recordEvent({
            type: 'settle',
            tokens: collectConsumerTokens(node, true),
          })
        }
      },

      'VariableDeclarator:exit' (node) {
        if (
          node.parent.type !== 'VariableDeclaration' ||
          node.parent.kind !== 'const' ||
          node.id.type !== 'Identifier' ||
          !node.init ||
          !['CallExpression', 'ChainExpression', 'Identifier'].includes(node.init.type)
        ) {
          return
        }

        const variable = resolveVariable(node.id)
        const tokens = collectTokens(node.init)
        if (variable && tokens.size > 0) variableTokens.set(variable, tokens)
      },

      'ReturnStatement:exit' (node) {
        if (!node.argument) return
        recordEvent({
          type: 'settle',
          tokens: collectTokens(node.argument, true),
        })
      },

      'AwaitExpression:exit' (node) {
        recordEvent({
          type: 'await',
          handled: collectTokens(node.argument, true),
          node,
        })
      },

      ForOfStatement (node) {
        if (!node.await) return

        let handled = new Set()
        if (node.right.type === 'ArrayExpression') {
          handled = unionTokenSets(node.right.elements.map(element => {
            if (!element || element.type === 'SpreadElement' || element.type === 'ArrayExpression') return new Set()
            return collectTokens(element, true)
          }))
        }

        recordEvent({
          type: 'await',
          handled,
          node,
        })
      },
    }
  },
}
