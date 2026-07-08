'use strict'

// Custom transforms registered via InstrumentationMatcher.addTransform().
//
// Use this file for transforms that are not yet supported upstream in
// @apm-js-collab/code-transformer (Orchestrion) or that cannot land there
// for dd-trace-specific reasons. Once a transform is available natively in
// the library, replace the custom registration with the built-in option and
// remove the entry here.

const clone = require('../../../../../vendor/dist/rfdc')({ proto: false, circles: false })

const { parse, query } = require('./compiler')

module.exports = { waitForAsyncEnd }

/**
 * Injects a wait for `ctx.asyncEndPromise` into a generated `tracePromise`
 * wrapper's native-Promise fulfillment handler.
 *
 * @param {object} _state
 * @param {import('estree').CallExpression} node
 * @returns {void}
 */
function waitForAsyncEnd (_state, node) {
  const onFulfilled = node.arguments[0]
  const statements = onFulfilled?.body?.body

  if (!statements || query(onFulfilled.body, '[id.name=__apm$asyncEndPromise]').length > 0) {
    return
  }

  const returnIndex = statements.findIndex(statement =>
    statement.type === 'ReturnStatement' && statement.argument
  )

  // The generated fulfillment handler always ends in a return; this only guards
  // against a future template shape the transform can no longer splice into.
  /* istanbul ignore next */
  if (returnIndex === -1) return

  const waitStatements = parse(`
    function wrapper () {
      const __apm$asyncEndPromise = __apm$ctx.asyncEndPromise;
      if (__apm$asyncEndPromise && typeof __apm$asyncEndPromise.then === 'function') {
        return __apm$asyncEndPromise.then(() => __apm$result, () => __apm$result);
      }
    }
  `).body[0].body.body

  // Resolve to whatever the fulfillment handler returns (its return argument),
  // so a subscriber that reassigned `__apm$ctx.result` in `asyncEnd` still wins.
  const returnArgument = statements[returnIndex].argument
  const { arguments: onSettled } = waitStatements[1].consequent.body[0].argument
  onSettled[0].body = clone(returnArgument)
  onSettled[1].body = clone(returnArgument)

  statements.splice(returnIndex, 0, ...waitStatements)
}
