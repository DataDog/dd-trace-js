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

module.exports = {
  configureGraphqlJitCompileObject,
  configureGraphqlJitExecute,
  waitForAsyncEnd,
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitCompileObject (_state, node) {
  const nestedTypeChecks = query(
    node,
    'IfStatement > LogicalExpression[operator="&&"] > UnaryExpression[operator="!"]' +
      '[argument.name="alwaysDefer"]'
  )
  const defaultResolverAssignments = query(
    node,
    'IfStatement[test.operator="&&"]:has(UnaryExpression[operator="!"][argument.name="resolver"])' +
      ':has(Identifier[name="alwaysDefer"]) AssignmentExpression[left.name="resolver"]'
  )

  assert.strictEqual(
    nestedTypeChecks.length,
    1,
    'configureGraphqlJitCompileObject: nested type check not found'
  )
  assert.strictEqual(
    defaultResolverAssignments.length,
    1,
    'configureGraphqlJitCompileObject: default resolver assignment not found'
  )

  const [nestedTypeCheck] = nestedTypeChecks
  const left = nestedTypeCheck.argument
  nestedTypeCheck.type = 'BinaryExpression'
  nestedTypeCheck.operator = '!=='
  nestedTypeCheck.left = left
  nestedTypeCheck.right = { type: 'Literal', value: true, raw: 'true' }
  delete nestedTypeCheck.prefix
  delete nestedTypeCheck.argument

  const [defaultResolverAssignment] = defaultResolverAssignments
  defaultResolverAssignment.right = parse(`(
    alwaysDefer === true
      ? (parent) => parent && parent[fieldName]
      : (parent) => parent?.[fieldName]
  )`).body[0].expression

  // `true` defers defaults but also suppresses isTypeOf. A separate truthy value,
  // paired with the transformed `!== true` check, preserves both behaviors.
  node.body.body.unshift(...parse(`
    if (context.ddTraceDefaultResolvers && alwaysDefer === false) {
      alwaysDefer = 'datadog'
    }
  `).body)
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionExpression} node
 */
function configureGraphqlJitExecute (_state, node) {
  const [context] = query(node, 'VariableDeclarator[id.name="__apm$ctx"] > ObjectExpression')
  const [tracedBody] = query(
    node,
    'VariableDeclarator[id.name="__apm$traced"] > ArrowFunctionExpression > BlockStatement'
  )

  assert(context && tracedBody, 'configureGraphqlJitExecute: incomplete orchestrion wrapper')

  const properties = parse(`({
    ddDocument: document,
    ddOperationName: operationName,
    ddResolvers: compilationContext.resolvers,
    ddSchema: compilationContext.schema
  })`).body[0].expression.properties

  context.properties.push(...properties)

  tracedBody.body.unshift(...parse(`
    if (__apm$ctx.ddAborted) {
      const __apm$abortError = new Error('Aborted')
      __apm$abortError.name = 'AbortError'
      throw __apm$abortError
    }
  `).body)
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
  const statements = onFulfilled?.body?.body

  if (!statements || query(onFulfilled.body, '[id.name=__apm$asyncEndPromise]').length > 0) {
    return
  }

  const returnIndex = statements.findIndex(statement =>
    statement.type === 'ReturnStatement' && statement.argument
  )

  // The generated fulfillment handler always ends in a return; a miss means the
  // upstream template changed and the caller's try/catch falls back to the
  // unwrapped source.
  assert(returnIndex !== -1, 'waitForAsyncEnd: no return statement to wait on')

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
