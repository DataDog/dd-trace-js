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

module.exports = { waitForAsyncEnd }

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
