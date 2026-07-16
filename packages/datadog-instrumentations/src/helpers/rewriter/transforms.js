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

module.exports = { syncNoSubscriberFastPath, waitForAsyncEnd }

/**
 * Hoists a sync wrapper's subscriber check ahead of its generated argument,
 * context, and closure allocations. The original body is copied into the fast
 * branch so disabled instrumentation pays only the channel predicate.
 *
 * @param {object} _state
 * @param {import('estree').FunctionExpression} node
 * @returns {void}
 */
function syncNoSubscriberFastPath (_state, node) {
  const statements = node.body.body
  const tracedDeclaration = findVariableDeclaration(statements, '__apm$traced')
  const tracedFunction = tracedDeclaration?.declarations[0].init
  assert(tracedFunction?.type === 'ArrowFunctionExpression', 'sync fast path: traced function not found')
  assert(tracedFunction.body.type === 'BlockStatement', 'sync fast path: traced function body not found')

  const wrappedDeclaration = findVariableDeclaration(tracedFunction.body.body, '__apm$wrapped')
  const originalFunction = wrappedDeclaration?.declarations[0].init
  assert(originalFunction?.type === 'FunctionExpression', 'sync fast path: original function not found')

  const subscriberGate = statements.find(statement => statement.type === 'IfStatement')
  assert(subscriberGate?.type === 'IfStatement', 'sync fast path: subscriber gate not found')

  const aliases = []
  for (let index = 0; index < originalFunction.params.length; index++) {
    const originalParam = originalFunction.params[index]
    const wrapperParam = node.params[index]
    assert(originalParam.type === 'Identifier', 'sync fast path: original parameter must be an identifier')
    assert(wrapperParam.type === 'Identifier', 'sync fast path: wrapper parameter must be an identifier')
    aliases.push(`${originalParam.name} = ${wrapperParam.name}`)
  }

  const fastStatements = clone(originalFunction.body.body)
  if (aliases.length > 0) {
    fastStatements.unshift(parse(`function wrapper () { const ${aliases.join(', ')} }`).body[0].body.body[0])
  }
  fastStatements.push(parse('function wrapper () { return }').body[0].body.body[0])

  statements.unshift({
    type: 'IfStatement',
    test: clone(subscriberGate.test),
    consequent: {
      type: 'BlockStatement',
      body: fastStatements,
    },
    alternate: null,
  })
}

/**
 * @param {import('estree').Statement[]} statements
 * @param {string} name
 * @returns {import('estree').VariableDeclaration | undefined}
 */
function findVariableDeclaration (statements, name) {
  let declaration
  for (const statement of statements) {
    if (statement.type === 'VariableDeclaration' &&
        statement.declarations[0]?.id.type === 'Identifier' &&
        statement.declarations[0].id.name === name) {
      declaration = statement
      break
    }
  }
  return declaration
}

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
  assert(
    onFulfilled?.type === 'ArrowFunctionExpression' || onFulfilled?.type === 'FunctionExpression',
    'waitForAsyncEnd: fulfillment handler not found'
  )
  assert(onFulfilled.body.type === 'BlockStatement', 'waitForAsyncEnd: fulfillment handler body not found')

  const statements = onFulfilled.body.body
  if (query(onFulfilled.body, '[id.name=__apm$asyncEndPromise]').length > 0) {
    return
  }

  const returnIndex = statements.findIndex(statement =>
    statement.type === 'ReturnStatement' && statement.argument
  )

  // The generated fulfillment handler always ends in a return; a miss means the
  // upstream template changed and the caller's try/catch falls back to the
  // unwrapped source.
  assert(returnIndex !== -1, 'waitForAsyncEnd: no return statement to wait on')
  const returnStatement = statements[returnIndex]
  assert(returnStatement.type === 'ReturnStatement' && returnStatement.argument)

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
  const returnArgument = returnStatement.argument
  const { arguments: onSettled } = waitStatements[1].consequent.body[0].argument
  onSettled[0].body = clone(returnArgument)
  onSettled[1].body = clone(returnArgument)

  statements.splice(returnIndex, 0, ...waitStatements)
}
