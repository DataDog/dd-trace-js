'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()

const graphql = require('graphql')
const executeModule = require('graphql/execution/execute.js')

require('../../datadog-instrumentations/src/graphql')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const executeHook = instrumentations.graphql.find(entry => entry.file === 'execution/execute.js')
executeHook.hook(executeModule)

const startResolveCh = dc.channel('apm:graphql:resolve:start')
const finishResolveCh = dc.channel('apm:graphql:resolve:finish')
const resolverStartCh = dc.channel('datadog:graphql:resolver:start')

// Keep the start/finish execute channels live so the wrapped executor emits resolve events.
const noopChannels = [
  dc.channel('apm:graphql:execute:start'),
  dc.channel('apm:graphql:execute:finish'),
]
const noop = () => {}

function buildSchema () {
  const Person = new graphql.GraphQLObjectType({
    name: 'Person',
    fields: {
      name: { type: graphql.GraphQLString },
      friends: {
        type: new graphql.GraphQLList(graphql.GraphQLString),
        resolve: () => ['alice', 'bob'],
      },
    },
  })
  return new graphql.GraphQLSchema({
    query: new graphql.GraphQLObjectType({
      name: 'Query',
      fields: {
        people: {
          type: new graphql.GraphQLList(Person),
          resolve: () => [{ name: 'eve' }],
        },
        ping: {
          type: graphql.GraphQLString,
          resolve: () => 'pong',
        },
      },
    }),
  })
}

describe('graphql instrumentation pathToArray (regression for two-walk rewrite)', () => {
  beforeEach(() => {
    for (const channel of noopChannels) channel.subscribe(noop)
  })

  afterEach(() => {
    for (const channel of noopChannels) channel.unsubscribe(noop)
  })

  it('produces the path in root-to-leaf order with mixed string/number segments', () => {
    const captured = []
    const listener = (fieldCtx) => captured.push({
      pathString: fieldCtx.pathString,
      path: fieldCtx.path,
    })
    startResolveCh.subscribe(listener)

    try {
      const result = executeModule.execute({
        schema: buildSchema(),
        document: graphql.parse('{ people { name friends } }'),
      })
      assert.equal(result.errors, undefined)
    } finally {
      startResolveCh.unsubscribe(listener)
    }

    const peoplePath = captured.find(entry => entry.pathString === 'people')
    assert.ok(peoplePath, 'expected a fieldCtx for "people"')
    assert.deepEqual(peoplePath.path, ['people'])

    const namePath = captured.find(entry => entry.pathString === 'people.0.name')
    assert.ok(namePath, 'expected a fieldCtx for "people.0.name"')
    assert.deepEqual(namePath.path, ['people', 0, 'name'])
  })

  it('handles a depth-1 path without leaking holey-array shape', () => {
    const captured = []
    const listener = (fieldCtx) => captured.push(fieldCtx.path)
    startResolveCh.subscribe(listener)

    try {
      executeModule.execute({
        schema: buildSchema(),
        document: graphql.parse('{ ping }'),
      })
    } finally {
      startResolveCh.unsubscribe(listener)
    }

    const ping = captured.find(path => path[0] === 'ping')
    assert.ok(ping, 'expected a path for "ping"')
    assert.deepEqual(ping, ['ping'])
    assert.equal(ping.length, 1)
  })

  it('publishes one finishResolveCh event per started field (regression for finishResolvers without reverse)', () => {
    const startedPaths = []
    const finishedPaths = []
    const onStart = (ctx) => startedPaths.push(ctx.pathString)
    const onFinish = (ctx) => finishedPaths.push(ctx.pathString)
    startResolveCh.subscribe(onStart)
    finishResolveCh.subscribe(onFinish)

    try {
      executeModule.execute({
        schema: buildSchema(),
        document: graphql.parse('{ ping people { name } }'),
      })
    } finally {
      startResolveCh.unsubscribe(onStart)
      finishResolveCh.unsubscribe(onFinish)
    }

    assert.deepEqual(finishedPaths.slice().sort(), startedPaths.slice().sort())
  })
})

describe('graphql plugin getResolverInfo (regression for lazy allocation)', () => {
  let GraphQLResolvePlugin
  let plugin
  let updateFieldHandler
  const channelEvents = []
  const startSpanCalls = []

  beforeEach(() => {
    class StubTracingPlugin {
      constructor () {
        this.config = {}
        this._tracerConfig = {}
      }

      addTraceSub (eventName, handler) {
        if (eventName === 'updateField') updateFieldHandler = handler
      }

      addSub () {}
      startSpan (operationName, options) {
        startSpanCalls.push({ operationName, options })
        return {
          setTag: () => {},
          finish: () => {},
          addTags: () => {},
          context: () => ({ _trace: { started: [] }, _tags: {} }),
          _spanContext: { _tags: {} },
          _getTime: () => 0,
        }
      }

      configure (config) {
        this.config = config && typeof config === 'object' ? config : {}
      }
    }

    GraphQLResolvePlugin = proxyquire('../src/resolve', {
      '../../dd-trace/src/plugins/tracing': StubTracingPlugin,
    })

    plugin = new GraphQLResolvePlugin()
    plugin.configure({ depth: -1, collapse: false, source: false, variables: null })

    const onResolverStart = (event) => channelEvents.push(event)
    plugin._listener = onResolverStart
    resolverStartCh.subscribe(onResolverStart)
  })

  afterEach(() => {
    resolverStartCh.unsubscribe(plugin._listener)
    channelEvents.length = 0
    startSpanCalls.length = 0
  })

  it('emits resolverInfo === null when args is undefined and no directives are present', () => {
    plugin.start(makeFieldCtx({ args: undefined }))

    assert.equal(channelEvents.length, 1)
    assert.equal(channelEvents[0].resolverInfo, null)
  })

  it('emits resolverInfo === null when args is an empty object and no directives are present', () => {
    plugin.start(makeFieldCtx({ args: {} }))

    assert.equal(channelEvents.length, 1)
    assert.equal(channelEvents[0].resolverInfo, null)
  })

  it('emits resolverInfo with all keys when args is non-empty', () => {
    plugin.start(makeFieldCtx({
      args: { id: 1, role: 'admin', extra: 'a', other: 'b', last: 'c' },
    }))

    assert.equal(channelEvents.length, 1)
    assert.deepEqual(channelEvents[0].resolverInfo, {
      greet: { id: 1, role: 'admin', extra: 'a', other: 'b', last: 'c' },
    })
  })

  it('emits resolverInfo containing directive arguments when args is empty', () => {
    plugin.start(makeFieldCtx({
      args: undefined,
      directives: [
        {
          name: { value: 'auth' },
          arguments: [{ name: { value: 'role' }, value: { value: 'admin' } }],
        },
        { name: { value: 'flag' }, arguments: [] },
      ],
    }))

    assert.equal(channelEvents.length, 1)
    assert.deepEqual(channelEvents[0].resolverInfo, {
      greet: { auth: { role: 'admin' } },
    })
  })

  it('merges args and directive arguments into a single resolverInfo entry', () => {
    plugin.start(makeFieldCtx({
      args: { id: 7 },
      directives: [
        {
          name: { value: 'auth' },
          arguments: [{ name: { value: 'role' }, value: { value: 'admin' } }],
        },
      ],
    }))

    assert.equal(channelEvents.length, 1)
    assert.deepEqual(channelEvents[0].resolverInfo, {
      greet: { id: 7, auth: { role: 'admin' } },
    })
  })

  it('skips the resolver when depth >= 0 and the path is deeper than the configured limit', () => {
    plugin.configure({ depth: 0, collapse: false, source: false, variables: null })
    plugin.start(makeFieldCtx({ args: undefined, path: ['people', 0, 'name'], pathString: 'people.0.name' }))

    assert.equal(channelEvents.length, 0)
  })

  it('counts only string segments in the slow path of shouldInstrument', () => {
    plugin.configure({ depth: 1, collapse: false, source: false, variables: null })
    plugin.start(makeFieldCtx({ args: undefined, path: ['people', 0, 'name'], pathString: 'people.0.name' }))

    assert.equal(channelEvents.length, 0)

    plugin.configure({ depth: 2, collapse: false, source: false, variables: null })
    plugin.start(makeFieldCtx({ args: undefined, path: ['people', 0, 'name'], pathString: 'people.0.name' }))

    assert.equal(channelEvents.length, 1)
  })

  it('updateField stamps finishTime and propagates errors when shouldInstrument allows the path', () => {
    const field = { error: null, ctx: {} }
    const ctx = {
      field,
      error: new Error('boom'),
      path: ['greet'],
      currentStore: { span: { _getTime: () => 1234 } },
    }
    updateFieldHandler(ctx)

    assert.equal(field.finishTime, 1234)
    assert.equal(field.error.message, 'boom')
  })

  it('updateField bails out when shouldInstrument rejects the path', () => {
    plugin.configure({ depth: 1, collapse: false, source: false, variables: null })
    const field = { error: null, ctx: {} }
    updateFieldHandler({
      field,
      error: new Error('ignored'),
      path: ['people', 0, 'name'],
      currentStore: { span: { _getTime: () => 1 } },
    })

    assert.equal(field.finishTime, undefined)
    assert.equal(field.error, null)
  })

  it('collapses numeric segments to "*" and counts every segment when collapse is enabled', () => {
    plugin.configure({ depth: 2, collapse: true, source: false, variables: null })
    plugin.start(makeFieldCtx({ args: undefined, path: ['people', 0, 'name'], pathString: 'people.0.name' }))

    assert.equal(channelEvents.length, 0)

    plugin.configure({ depth: 3, collapse: true, source: false, variables: null })
    plugin.start(makeFieldCtx({ args: undefined, path: ['people', 0, 'name'], pathString: 'people.0.name' }))

    assert.equal(channelEvents.length, 1)
    assert.equal(startSpanCalls.at(-1).options.meta['graphql.field.path'], 'people.*.name')
  })
})

describe('graphql plugin addVariableTags (regression for early-return)', () => {
  let GraphQLExecutePlugin
  let plugin
  const addTagsCalls = []

  beforeEach(() => {
    class StubTracingPlugin {
      constructor () {
        this.config = {}
        this._tracerConfig = {}
      }

      operationName () { return 'graphql.execute' }
      serviceName () { return 'svc' }

      startSpan () {
        return {
          addTags: (tags) => addTagsCalls.push(tags),
          context: () => ({ _trace: { started: [] }, _tags: {} }),
          _spanContext: { _tags: {} },
        }
      }

      configure (config) {
        this.config = config && typeof config === 'object' ? config : {}
      }
    }

    GraphQLExecutePlugin = proxyquire('../src/execute', {
      '../../dd-trace/src/plugins/tracing': StubTracingPlugin,
    })

    plugin = new GraphQLExecutePlugin()
  })

  afterEach(() => {
    addTagsCalls.length = 0
  })

  it('skips span.addTags when variableValues is undefined', () => {
    plugin.configure({ variables: () => ({}), source: false, signature: false, hooks: { execute: () => {} } })
    plugin.bindStart({ operation: undefined, args: { document: undefined, variableValues: undefined } })

    assert.equal(addTagsCalls.length, 0)
  })

  it('skips span.addTags when config.variables is not configured', () => {
    plugin.configure({ variables: undefined, source: false, signature: false, hooks: { execute: () => {} } })
    plugin.bindStart({ operation: undefined, args: { document: undefined, variableValues: { id: 1 } } })

    assert.equal(addTagsCalls.length, 0)
  })

  it('forwards graphql.variables.* tags when both variables and a serializer are present', () => {
    plugin.configure({
      variables: (vars) => vars,
      source: false,
      signature: false,
      hooks: { execute: () => {} },
    })
    plugin.bindStart({ operation: undefined, args: { document: undefined, variableValues: { id: 1, role: 'admin' } } })

    assert.equal(addTagsCalls.length, 1)
    assert.deepEqual(addTagsCalls[0], {
      'graphql.variables.id': 1,
      'graphql.variables.role': 'admin',
    })
  })
})

function makeFieldCtx ({ args, directives, path = ['greet'], pathString = path.join('.') } = {}) {
  const fieldNode = {
    kind: 'Field',
    arguments: [],
    directives: directives ?? [],
    loc: undefined,
  }
  return {
    info: {
      fieldName: 'greet',
      returnType: { name: 'String', toString: () => 'String' },
      fieldNodes: [fieldNode],
      variableValues: {},
    },
    rootCtx: { fields: Object.create(null), source: undefined },
    args,
    path,
    pathString,
  }
}
