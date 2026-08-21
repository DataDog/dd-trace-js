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

module.exports = { awaitContextCallback, syncNoSubscriberFastPath, undiciClientOrigin, waitForAsyncEnd }

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
    fastStatements.unshift(parse(`function wrapper () { let ${aliases.join(', ')} }`).body[0].body.body[0])
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
 * Preserves the Client origin in the generated context for Undici 4, whose
 * diagnostic Request object does not expose it.
 *
 * @param {object} _state
 * @param {import('estree').FunctionExpression} node
 * @returns {void}
 */
function undiciClientOrigin (_state, node) {
  const contextDeclaration = findVariableDeclaration(node.body.body, '__apm$ctx')
  const context = contextDeclaration?.declarations[0].init
  assert(context?.type === 'ObjectExpression', 'undici origin: context not found')

  const originProperty = query(
    parse('const context = { origin: this[kUrl].origin }'),
    'Property[key.name="origin"]'
  )[0]
  assert(originProperty?.type === 'Property', 'undici origin: property not found')
  context.properties.push(originProperty)
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
