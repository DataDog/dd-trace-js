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
  configureGraphqlJitExecutionInfo,
  configureGraphqlJitRuntime,
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
  const defaultResolverConditions = query(
    node,
    'IfStatement[test.operator="&&"]:has(UnaryExpression[operator="!"][argument.name="resolver"])' +
      ':has(Identifier[name="alwaysDefer"])'
  )
  const resolverConditions = query(node, 'IfStatement[test.name="resolver"]')
  const compileTypeCalls = query(node, 'CallExpression[callee.name="compileType"]')

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
  assert.strictEqual(
    defaultResolverConditions.length,
    1,
    'configureGraphqlJitCompileObject: default resolver condition not found'
  )
  assert.strictEqual(
    resolverConditions.length,
    1,
    'configureGraphqlJitCompileObject: resolver condition not found'
  )
  assert.strictEqual(
    compileTypeCalls.length,
    1,
    'configureGraphqlJitCompileObject: inline compile call not found'
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

  const [defaultResolverCondition] = defaultResolverConditions
  const [resolverCondition] = resolverConditions
  const [compileTypeCall] = compileTypeCalls
  const inlineCompileCall = clone(compileTypeCall)
  inlineCompileCall.arguments[4] = {
    type: 'ArrayExpression',
    elements: [{ type: 'Literal', value: '__ddValue' }],
  }

  const [defaultMarker] = parse(`
    const ddTraceDefault = !resolver && alwaysDefer === 'datadog'
  `).body
  const [fastDefaultMarker] = parse(`
    const ddTraceFastDefault = ddTraceDefault && context.ddTraceRuntime.canInlineDefault(fieldNodes)
  `).body
  replaceIdentifier(fastDefaultMarker, 'fieldNodes', clone(compileTypeCall.arguments[3]))
  const [inlineField] = parse(`
    const ddTraceInline = ddTraceDefault
      ? context.ddTraceRuntime.compileDefaultField(
        context,
        DD_PATH,
        type,
        field,
        DD_FIELD_NODES,
        originPaths,
        DD_COMPILED
      )
      : undefined
  `).body
  replaceIdentifier(inlineField, 'DD_PATH', clone(compileTypeCall.arguments[6]))
  replaceIdentifier(inlineField, 'DD_FIELD_NODES', clone(compileTypeCall.arguments[3]))
  replaceIdentifier(inlineField, 'DD_COMPILED', inlineCompileCall)

  assert(
    insertBeforeStatement(node.body, defaultResolverCondition, [defaultMarker]),
    'configureGraphqlJitCompileObject: could not insert default marker'
  )
  assert(
    insertBeforeStatement(node.body, resolverCondition, [fastDefaultMarker, inlineField]),
    'configureGraphqlJitCompileObject: could not insert inline field'
  )

  const includedConditions = query(resolverCondition.consequent, 'IfStatement[test.name="alwaysIncluded"]')
  let fastDefaultBody
  if (includedConditions.length === 1) {
    fastDefaultBody = parse(`
      if (alwaysIncluded) {
        body(ddTraceInline)
      } else {
        body(\`? \${ddTraceInline} : undefined\`)
      }
    `).body
  } else {
    assert.strictEqual(
      includedConditions.length,
      0,
      'configureGraphqlJitCompileObject: ambiguous included condition'
    )
    fastDefaultBody = parse(`
      body(\`? \${ddTraceInline} : undefined\`)
    `).body
  }

  const originalResolverBody = resolverCondition.consequent
  const [fastDefaultCondition] = parse(`
    if (ddTraceFastDefault) {}
  `).body
  fastDefaultCondition.consequent.body.push(...fastDefaultBody)
  fastDefaultCondition.alternate = originalResolverBody
  resolverCondition.consequent = {
    type: 'BlockStatement',
    body: [fastDefaultCondition],
  }

  // `true` defers defaults but also suppresses isTypeOf. A separate truthy value,
  // paired with the transformed `!== true` check, preserves both behaviors.
  node.body.body.unshift(...parse(`
    if (context.ddTraceDefaultResolvers && alwaysDefer === false) {
      alwaysDefer = 'datadog'
    }
  `).body)
}

/**
 * @param {import('estree').Node} root
 * @param {string} name
 * @param {import('estree').Node} replacement
 */
function replaceIdentifier (root, name, replacement) {
  for (const key of Object.keys(root)) {
    const value = root[key]
    if (!value || typeof value !== 'object') continue
    if (value.type === 'Identifier' && value.name === name) {
      root[key] = clone(replacement)
    } else {
      replaceIdentifier(value, name, replacement)
    }
  }
}

/**
 * @param {import('estree').Node} root
 * @param {import('estree').Node} target
 * @param {import('estree').Node[]} statements
 * @returns {boolean}
 */
function insertBeforeStatement (root, target, statements) {
  for (const key of Object.keys(root)) {
    const value = root[key]
    if (Array.isArray(value)) {
      const index = value.indexOf(target)
      if (index !== -1) {
        value.splice(index, 0, ...statements)
        return true
      }
      for (const entry of value) {
        if (entry && typeof entry === 'object' && insertBeforeStatement(entry, target, statements)) return true
      }
    } else if (value && typeof value === 'object' && insertBeforeStatement(value, target, statements)) {
      return true
    }
  }
  return false
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
    ddPlan: compilationContext.ddTraceRuntime?.getPlan(compilationContext),
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
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitExecutionInfo (_state, node) {
  const enrichers = query(
    node,
    'MemberExpression[property.name="resolverInfoEnricher"]' +
      ':has(MemberExpression[object.name="context"][property.name="options"])'
  )

  assert.strictEqual(
    enrichers.length,
    1,
    'configureGraphqlJitExecutionInfo: resolver info enricher not found'
  )

  const replacement = parse(`
    context.ddTraceRuntime
      ? context.ddTraceRuntime.createResolverInfoEnricher(
        context,
        responsePath,
        context.options.resolverInfoEnricher
      )
      : context.options.resolverInfoEnricher
  `).body[0].expression
  const [enricher] = enrichers
  for (const key of Object.keys(enricher)) delete enricher[key]
  Object.assign(enricher, replacement)
}

/**
 * @param {object} _state
 * @param {import('estree').FunctionDeclaration} node
 */
function configureGraphqlJitRuntime (_state, node) {
  const contexts = query(node, 'VariableDeclarator[id.name="executionContext"] > ObjectExpression')
  assert.strictEqual(
    contexts.length,
    1,
    'configureGraphqlJitRuntime: execution context not found'
  )

  const properties = parse(`({
    ddTrace: compilationContext.ddTraceRuntime?.startExecution()
  })`).body[0].expression.properties
  contexts[0].properties.push(...properties)

  const returns = query(node, 'ReturnStatement[argument.object.name="ret"]')
  assert.strictEqual(returns.length, 1, 'configureGraphqlJitRuntime: compiled query return not found')
  assert(
    insertBeforeStatement(node.body, returns[0], parse(`
      compilationContext.ddTraceRuntime?.getPlan(compilationContext)
    `).body),
    'configureGraphqlJitRuntime: could not finalize the plan'
  )
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
