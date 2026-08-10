'use strict'

// Custom transforms registered via InstrumentationMatcher.addTransform().
//
// Use this file for transforms that are not yet supported upstream in
// @apm-js-collab/code-transformer (Orchestrion) or that cannot land there
// for dd-trace-specific reasons. Once a transform is available natively in
// the library, replace the custom registration with the built-in option and
// remove the entry here.

const assert = require('node:assert')

const clone = require('../../../../../vendor/dist/rfdc')({ proto: false, circles: false })

const { parse, query } = require('./compiler')

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])
const identifierPattern = /^[$A-Z_a-z][$\w]*$/

module.exports = { awaitContextCallback, waitForAsyncEnd }

/**
 * Awaits an optional context callback before continuing through a matched conditional branch.
 *
 * The branch condition is checked again after the callback settles so the
 * original body does not run against state that changed while awaiting.
 *
 * @param {{
 *   transformOptions?: {
 *     callbackArgumentNames?: string[],
 *     callbackName?: string
 *   }
 * }} state
 * @param {import('estree').IfStatement} node
 * @param {import('estree').Node} _parent
 * @param {import('estree').Node[]} ancestry
 * @returns {void}
 */
function awaitContextCallback (state, node, _parent, ancestry) {
  assert(node.type === 'IfStatement' && node.consequent?.type === 'BlockStatement',
    'awaitContextCallback: expected an if statement with a block body')

  const { callbackArgumentNames = [], callbackName } = state.transformOptions ?? {}

  assert(identifierPattern.test(callbackName), 'awaitContextCallback: callbackName must be an identifier')
  assert(callbackArgumentNames.every(name => identifierPattern.test(name)),
    'awaitContextCallback: callbackArgumentNames must be identifiers')

  let enclosingFunction
  let hasTraceWrapper = false
  for (const ancestor of ancestry) {
    if (!functionTypes.has(ancestor.type)) continue

    enclosingFunction ??= ancestor
    if (ancestor.body?.type !== 'BlockStatement') continue

    let hasContextBinding = false
    let hasTracedBinding = false
    for (const statement of ancestor.body.body) {
      if (statement.type !== 'VariableDeclaration') continue

      for (const declaration of statement.declarations) {
        hasContextBinding ||= declaration.id?.name === '__apm$ctx'
        hasTracedBinding ||= declaration.id?.name === '__apm$traced'
      }
    }
    hasTraceWrapper ||= hasContextBinding && hasTracedBinding
  }

  assert(enclosingFunction?.async, 'awaitContextCallback: expected an enclosing async function')
  assert(hasTraceWrapper, 'awaitContextCallback: expected an enclosing trace wrapper')

  const callbackVariable = `__apm$${callbackName}`
  if (query(node, `[id.name="${callbackVariable}"]`).length > 0) {
    return
  }

  const originalStatements = node.consequent.body
  const callbackStatements = parse(`
    async function wrapper () {
      const ${callbackVariable} = __apm$ctx.${callbackName};
      if (typeof ${callbackVariable} === 'function') {
        try {
          await ${callbackVariable}(${callbackArgumentNames.join(', ')});
        } catch {}
        if (true) {}
      } else {
      }
    }
  `).body[0].body.body

  const callbackBranch = callbackStatements[1]
  const recheckedBranch = callbackBranch.consequent.body[1]
  recheckedBranch.test = clone(node.test)
  recheckedBranch.consequent.body.push(...clone(originalStatements))
  recheckedBranch.alternate = clone(node.alternate)
  callbackBranch.alternate.body.push(...originalStatements)
  node.consequent.body = callbackStatements
}

/**
 * Injects settlement-specific asyncEnd waits into a generated `tracePromise`
 * wrapper's native-Promise handlers.
 *
 * @param {object} _state
 * @param {import('estree').CallExpression} node
 * @returns {void}
 */
function waitForAsyncEnd (_state, node) {
  const onFulfilled = node.arguments[0]
  const onRejected = node.arguments[1]

  if (!onFulfilled?.body || !onRejected?.body) {
    return
  }

  injectAsyncEndCallbackWait(onFulfilled.body, 'ReturnStatement', 'resolveCallback')
  injectAsyncEndCallbackWait(onRejected.body, 'ThrowStatement', 'rejectCallback')
}

/**
 * Injects a settlement-specific callback wait before an exit.
 *
 * @param {import('estree').BlockStatement} body
 * @param {'ReturnStatement'|'ThrowStatement'} exitType
 * @param {'resolveCallback'|'rejectCallback'} callbackProperty
 * @returns {void}
 */
function injectAsyncEndCallbackWait (body, exitType, callbackProperty) {
  const callbackVariable = `__apm$${callbackProperty}`
  if (query(body, `[id.name=${callbackVariable}]`).length > 0) {
    return
  }

  const exitIndex = body.body.findIndex(statement =>
    statement.type === exitType && statement.argument
  )

  // The generated settlement handlers always end in a return or throw; a miss means the
  // upstream template changed and the caller's try/catch falls back to the
  // unwrapped source.
  assert(exitIndex !== -1, `waitForAsyncEnd: no ${exitType} to wait on`)

  // This runs inside tracePromise's native-Promise settlement handler. The
  // Promise adapts subscriber callback completion to that existing chain.
  const waitStatements = parse(`
    function wrapper () {
      const ${callbackVariable} = __apm$ctx.${callbackProperty};
      if (typeof ${callbackVariable} === 'function') {
        return new Promise(${callbackVariable}).then(() => __apm$result, () => __apm$result);
      }
    }
  `).body[0].body.body

  const exitArgument = body.body[exitIndex].argument
  const callbackIf = waitStatements[1]
  const { arguments: onCallbackSettled } = callbackIf.consequent.body[0].argument

  if (exitType === 'ThrowStatement') {
    for (const handler of onCallbackSettled) {
      handler.body = {
        type: 'BlockStatement',
        body: [{
          type: 'ThrowStatement',
          argument: clone(exitArgument),
        }],
      }
    }
  } else {
    onCallbackSettled[0].body = clone(exitArgument)
    onCallbackSettled[1].body = clone(exitArgument)
  }

  body.body.splice(exitIndex, 0, ...waitStatements)
}
