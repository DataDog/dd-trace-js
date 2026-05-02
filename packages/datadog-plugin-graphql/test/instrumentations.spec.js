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
  const channelEvents = []

  beforeEach(() => {
    class StubTracingPlugin {
      constructor () {
        this.config = {}
        this._tracerConfig = {}
      }

      addTraceSub () {}
      addSub () {}
      startSpan () {
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
})

function makeFieldCtx ({ args, directives }) {
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
    path: ['greet'],
    pathString: 'greet',
  }
}
