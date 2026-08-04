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
  postgresQueryBuild,
  postgresQueryHandlers,
  postgresQueryLifecycle,
  waitForAsyncEnd,
}

const POSTGRES_QUERY_REGISTRY = '__ddTracePostgresQueries'
const POSTGRES_QUERY_REGISTRY_SYMBOL = '__ddTracePostgresQueriesSymbol'
const POSTGRES_QUERY_SETTLED = '__ddTracePostgresQuerySettled'
const POSTGRES_READY = '__ddTracePostgresQueryReady'
const POSTGRES_OPTIONS = '__ddTracePostgresOptions'

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

/**
 * @param {object} state
 * @param {import('estree').Program} program
 */
function postgresQueryHandlers (state, program) {
  state.transforms.tracingChannelDeclaration(state, program)
  injectPostgresReadyCheck(program)
  capturePostgresOptions(program)

  const handlers = query(program, 'FunctionDeclaration[id.name="handler"]')
  assert(handlers.length >= 2 && handlers.length <= 3, 'postgresQueryHandlers: unexpected handler count')

  const channelVariable = postgresChannelVariable(state.channelName)
  for (const handler of handlers) {
    const queryParameter = handler.params[0]
    assert(queryParameter?.type === 'Identifier', 'postgresQueryHandlers: handler query parameter changed')

    const originalBody = handler.body.body
    const wrapperBody = parse(`
      function wrapper () {
        if (!${channelVariable}.start.hasSubscribers || !${POSTGRES_READY}) {
          return;
        }
        const __ddTraceContext = { query: ${queryParameter.name}, options: ${POSTGRES_OPTIONS} };
        return ${channelVariable}.start.runStores(__ddTraceContext, () => {});
      }
    `).body[0].body.body

    wrapperBody[0].consequent.body.unshift(...clone(originalBody))
    wrapperBody[2].argument.arguments[1].body.body = originalBody
    handler.body.body = wrapperBody
  }
}

/**
 * @param {import('estree').Program} program
 */
function capturePostgresOptions (program) {
  const postgresFunctions = query(program, 'FunctionDeclaration[id.name="Postgres"]')
  assert(postgresFunctions.length === 1, 'postgresQueryHandlers: Postgres function changed')

  const body = postgresFunctions[0].body.body
  const optionsIndex = body.findIndex(statement =>
    statement.type === 'VariableDeclaration' && statement.declarations.some(({ id }) => id.name === 'options')
  )
  assert(optionsIndex !== -1, 'postgresQueryHandlers: options declaration changed')

  const capture = parse(`const ${POSTGRES_OPTIONS} = options`).body[0]
  body.splice(optionsIndex + 1, 0, capture)
}

/**
 * @param {object} state
 * @param {import('estree').Program} program
 */
function postgresQueryLifecycle (state, program) {
  state.transforms.tracingChannelDeclaration(state, program)
  injectPostgresQueryRegistration(program)

  const resolveAssignments = query(
    program,
    'AssignmentExpression[left.object.type="ThisExpression"][left.property.name="resolve"]'
  )
  const rejectAssignments = query(
    program,
    'AssignmentExpression[left.object.type="ThisExpression"][left.property.name="reject"]'
  )

  assert(resolveAssignments.length === 2, 'postgresQueryLifecycle: unexpected resolve assignment count')
  assert(rejectAssignments.length === 2, 'postgresQueryLifecycle: unexpected reject assignment count')

  const channelVariable = postgresChannelVariable(state.channelName)
  for (const assignment of resolveAssignments) {
    wrapPostgresResolution(assignment, channelVariable)
  }
  for (const assignment of rejectAssignments) {
    wrapPostgresRejection(assignment, channelVariable)
  }
}

/**
 * @param {object} state
 * @param {import('estree').Program} program
 */
function postgresQueryBuild (state, program) {
  state.transforms.tracingChannelDeclaration(state, program)

  const builds = query(program, 'FunctionDeclaration[id.name="build"]')
  assert(builds.length === 1, 'postgresQueryBuild: unexpected build function count')

  const build = builds[0]
  const stringDeclarations = build.body.body.filter(statement =>
    statement.type === 'VariableDeclaration' && statement.declarations.some(({ id }) => id.name === 'string')
  )
  assert(stringDeclarations.length === 1, 'postgresQueryBuild: string declaration changed')
  stringDeclarations[0].kind = 'let'

  const prepareAssignments = query(
    build,
    'ExpressionStatement > AssignmentExpression[left.object.name="q"][left.property.name="prepare"]'
  )
  assert(prepareAssignments.length === 1, 'postgresQueryBuild: prepare assignment changed')

  const prepareIndex = build.body.body.findIndex(statement => statement.expression === prepareAssignments[0])
  assert(prepareIndex !== -1, 'postgresQueryBuild: prepare statement changed')

  const channelVariable = postgresChannelVariable(state.channelName)
  const publish = parse(`
    function wrapper () {
      if (${channelVariable}.asyncStart.hasSubscribers) {
        q.string = string;
        ${channelVariable}.asyncStart.publish(q);
        string = q.string;
      }
    }
  `).body[0].body.body[0]

  build.body.body.splice(prepareIndex + 1, 0, publish)
}

/**
 * @param {import('estree').Program} program
 */
function injectPostgresReadyCheck (program) {
  const statements = parse(`
    const ${POSTGRES_QUERY_REGISTRY} = globalThis[Symbol.for('dd-trace:postgres:query')]
    const ${POSTGRES_READY} = ${POSTGRES_QUERY_REGISTRY}?.has(Query) === true
  `).body
  const importIndex = program.body.findLastIndex(statement =>
    statement.type === 'ImportDeclaration' || statement.type === 'VariableDeclaration'
  )

  program.body.splice(importIndex + 1, 0, ...statements)
}

/**
 * @param {import('estree').Program} program
 */
function injectPostgresQueryRegistration (program) {
  const queryClassIndex = program.body.findIndex(statement =>
    statement.type === 'VariableDeclaration' && statement.declarations.some(({ id }) => id.name === 'Query') ||
      statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'ClassDeclaration' &&
        statement.declaration.id?.name === 'Query'
  )

  assert(queryClassIndex !== -1, 'postgresQueryLifecycle: Query class changed')

  const statements = parse(`
    const ${POSTGRES_QUERY_REGISTRY_SYMBOL} = Symbol.for('dd-trace:postgres:query')
    const ${POSTGRES_QUERY_REGISTRY} = globalThis[${POSTGRES_QUERY_REGISTRY_SYMBOL}] ||
      (globalThis[${POSTGRES_QUERY_REGISTRY_SYMBOL}] = new WeakSet())
    ${POSTGRES_QUERY_REGISTRY}.add(Query)
    function ${POSTGRES_QUERY_SETTLED} () {}
  `).body
  program.body.splice(queryClassIndex + 1, 0, ...statements)
}

/**
 * @param {import('estree').AssignmentExpression} assignment
 * @param {string} channelVariable
 */
function wrapPostgresResolution (assignment, channelVariable) {
  const resolution = assignment.right
  assert(
    resolution.type === 'ArrowFunctionExpression' && resolution.body.type !== 'BlockStatement',
    'postgresQueryLifecycle: resolve function changed'
  )

  const originalBody = resolution.body
  resolution.body = parse(`
    function wrapper () {
      this.resolve = this.reject = ${POSTGRES_QUERY_SETTLED};
      if (${channelVariable}.asyncEnd.hasSubscribers) {
        ${channelVariable}.asyncEnd.publish(this);
      }
      return undefined;
    }
  `).body[0].body
  resolution.expression = false
  resolution.body.body.at(-1).argument = originalBody
}

/**
 * @param {import('estree').AssignmentExpression} assignment
 * @param {string} channelVariable
 */
function wrapPostgresRejection (assignment, channelVariable) {
  const rejection = assignment.right
  const errorParameter = rejection.params[0]
  assert(
    rejection.type === 'ArrowFunctionExpression' &&
      rejection.body.type !== 'BlockStatement' &&
      errorParameter?.type === 'Identifier',
    'postgresQueryLifecycle: reject function changed'
  )

  const originalBody = rejection.body
  rejection.body = parse(`
    function wrapper () {
      this.resolve = this.reject = ${POSTGRES_QUERY_SETTLED};
      if (${channelVariable}.error.hasSubscribers) {
        const __ddTraceContext = { query: this, error: ${errorParameter.name} };
        ${channelVariable}.error.publish(__ddTraceContext);
      }
      if (${channelVariable}.asyncEnd.hasSubscribers) {
        ${channelVariable}.asyncEnd.publish(this);
      }
      return undefined;
    }
  `).body[0].body
  rejection.expression = false
  rejection.body.body.at(-1).argument = originalBody
}

/**
 * @param {string} channelName
 * @returns {string}
 */
function postgresChannelVariable (channelName) {
  return `tr_ch_apm$${channelName.replaceAll(/[^\w]/g, '_')}`
}
