'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const semver = require('semver')

const instrumentations = require('../../src/helpers/instrumentations')

function noop () {}

function withMethods (methods) {
  class Client {}
  for (const method of methods) Client.prototype[method] = noop
  return Client
}

const cases = [
  {
    name: 'tedious',
    version: '18.6.1',
    create: () => ({ Connection: withMethods(['makeRequest']), BulkLoad: withMethods(['getRowStream']) }),
    methods: ['Connection.prototype.makeRequest', 'BulkLoad.prototype.getRowStream'],
  },
  {
    name: 'mongodb',
    version: '6.19.0',
    create: () => ({ Collection: withMethods(['find', 'bulkWrite']) }),
    methods: ['Collection.prototype.find', 'Collection.prototype.bulkWrite'],
  },
  {
    name: 'cassandra-driver',
    version: '4.10.0',
    create: () => ({ Client: withMethods(['batch', '_execute']) }),
    methods: ['Client.prototype.batch', 'Client.prototype._execute'],
  },
  {
    name: 'cassandra-driver',
    version: '3.6.0',
    create: () => ({ Client: withMethods(['batch', '_innerExecute']) }),
    methods: ['Client.prototype.batch', 'Client.prototype._innerExecute'],
  },
  {
    name: 'ldapjs',
    version: '3.0.7',
    create: () => ({ Client: withMethods(['search', '_send', 'bind']) }),
    methods: ['Client.prototype.search', 'Client.prototype._send', 'Client.prototype.bind'],
  },
  {
    name: 'moleculer',
    version: '0.15.2',
    create: () => ({ ServiceBroker: withMethods(['call', 'registerMiddlewares']) }),
    methods: ['ServiceBroker.prototype.call', 'ServiceBroker.prototype.registerMiddlewares'],
  },
  {
    name: 'selenium-webdriver',
    file: 'selenium',
    version: '4.38.0',
    create: () => ({ WebDriver: withMethods(['get', 'quit']) }),
    methods: ['WebDriver.prototype.get', 'WebDriver.prototype.quit'],
  },
  {
    name: 'redis',
    version: '3.1.2',
    create: () => ({ RedisClient: withMethods(['internal_send_command']) }),
    methods: ['RedisClient.prototype.internal_send_command'],
  },
  {
    name: 'redis',
    version: '2.4.2',
    create: () => ({ RedisClient: withMethods(['send_command']) }),
    methods: ['RedisClient.prototype.send_command'],
  },
  {
    name: 'generic-pool',
    version: '2.4.3',
    create: () => ({ Pool: withMethods(['acquire']) }),
    methods: ['Pool.prototype.acquire'],
  },
  {
    name: '@elastic/transport',
    file: 'elasticsearch',
    version: '9.2.1',
    create: () => ({ Transport: withMethods(['request', 'getConnection']) }),
    methods: ['Transport.prototype.request', 'Transport.prototype.getConnection'],
  },
  {
    name: '@azure/functions',
    file: 'azure-functions',
    version: '4.10.0',
    create: () => ({
      app: Object.fromEntries([
        'deleteRequest', 'http', 'get', 'patch', 'post', 'put', 'serviceBusQueue', 'serviceBusTopic',
        'eventHub', 'cosmosDB', 'generic',
      ].map(name => [name, noop])),
    }),
    methods: ['app.http', 'app.generic'],
  },
  {
    name: 'durable-functions',
    file: 'azure-durable-functions',
    version: '3.5.0',
    create: () => ({ app: { entity: noop, activity: noop } }),
    methods: ['app.entity', 'app.activity'],
  },
  {
    name: 'protobufjs',
    version: '8.8.0',
    create: () => ({
      Root: Object.assign(withMethods(['load', 'loadSync']), { fromJSON: noop }),
      Type: Object.assign(withMethods(['fromObject']), { fromJSON: noop }),
    }),
    methods: ['Root.prototype.load', 'Root.prototype.loadSync', 'Root.fromJSON', 'Type.prototype.fromObject'],
  },
  {
    name: '@google-cloud/pubsub',
    file: 'google-cloud-pubsub',
    version: '5.0.0',
    create: () => ({
      Subscription: withMethods(['emit']),
      Topic: withMethods(['publish', 'publishMessage']),
      v1: {
        PublisherClient: withMethods(['publish']),
        SubscriberClient: withMethods(['pull']),
        SchemaServiceClient: withMethods(['getSchema']),
      },
    }),
    methods: [
      'Subscription.prototype.emit', 'Topic.prototype.publishMessage', 'Topic.prototype.publish',
      'v1.PublisherClient.prototype.publish', 'v1.SubscriberClient.prototype.pull',
      'v1.SchemaServiceClient.prototype.getSchema',
    ],
  },
  {
    name: 'cookie',
    version: '0.7.2',
    create: () => ({ parse: noop, parseCookie: noop }),
    methods: ['parse', 'parseCookie'],
  },
  {
    name: 'pug',
    version: '3.0.4',
    create: () => ({ compile: noop, compileClientWithDependenciesTracked: noop }),
    methods: ['compile', 'compileClientWithDependenciesTracked'],
  },
  {
    name: 'node-serialize',
    version: '0.0.4',
    create: () => ({ unserialize: noop }),
    methods: ['unserialize'],
  },
  {
    name: 'express-mongo-sanitize',
    version: '2.2.0',
    create: () => Object.assign(function sanitizeMiddleware () {}, { sanitize: noop }),
    methods: ['sanitize'],
  },
  {
    name: 'hapi',
    version: '18.1.0',
    create: () => ({ server: noop, Server: noop }),
    methods: ['server', 'Server'],
  },
  {
    name: '@hapi/hapi',
    file: 'hapi',
    version: '21.4.4',
    create: () => ({ server: noop, Server: noop }),
    methods: ['server', 'Server'],
  },
  {
    name: '@apollo/gateway',
    file: 'apollo',
    version: '2.11.2',
    create: () => ({ ApolloGateway: class ApolloGateway {} }),
    methods: ['ApolloGateway'],
  },
]

function get (object, path) {
  return path.split('.').reduce((value, key) => value[key], object)
}

describe('hooks for CommonJS exports shared with ESM namespaces', () => {
  for (const { name, file = name, version, create, methods } of cases) {
    it(`does not wrap ${name} twice and still wraps a second copy`, () => {
      require(`../../src/${file}`)
      const hooks = instrumentations[name].filter(({ versions, file, filePattern }) =>
        !file && !filePattern && versions.some(range => semver.satisfies(version, range)))
      assert.ok(hooks.length > 0)

      for (let copy = 0; copy < 2; copy++) {
        const exports = create()
        const initial = methods.map(method => get(exports, method))
        let wrapped = exports
        for (const { hook } of hooks) wrapped = hook(wrapped, version) ?? wrapped
        const once = methods.map(method => get(wrapped, method))
        for (const [index, method] of methods.entries()) {
          assert.notStrictEqual(once[index], initial[index], `${name}.${method} was not wrapped`)
        }

        // IITM sees a different namespace object, but both views share their classes and functions.
        const namespace = { default: wrapped, ...wrapped }
        for (const { hook } of hooks) hook(namespace, version, true)
        for (const [index, method] of methods.entries()) {
          assert.strictEqual(get(wrapped, method), once[index], `${name}.${method} was wrapped again`)
          if (!method.includes('.prototype.')) {
            assert.strictEqual(get(namespace, method), once[index], `${name}.${method} was wrapped through ESM`)
          }
        }
      }
    })
  }

  it('patches a distinct tedious BulkLoad even when its Connection was already patched', () => {
    require('../../src/tedious')
    const [{ hook }] = instrumentations.tedious
    const Connection = withMethods(['makeRequest'])
    const first = { Connection, BulkLoad: withMethods(['getRowStream']) }
    hook(first, '18.6.1')
    const once = Connection.prototype.makeRequest
    const BulkLoad = withMethods(['getRowStream'])
    const original = BulkLoad.prototype.getRowStream

    hook({ Connection, BulkLoad }, '18.6.1')

    assert.strictEqual(Connection.prototype.makeRequest, once)
    assert.notStrictEqual(BulkLoad.prototype.getRowStream, original)
  })

  it('patches a distinct protobufjs Type even when its Root was already patched', () => {
    require('../../src/protobufjs')
    const [{ hook }] = instrumentations.protobufjs
    const Root = Object.assign(withMethods(['load', 'loadSync']), { fromJSON: noop })
    const first = { Root, Type: Object.assign(withMethods(['fromObject']), { fromJSON: noop }) }
    hook(first, '8.8.0')
    const once = Root.prototype.load
    const Type = Object.assign(withMethods(['fromObject']), { fromJSON: noop })

    hook({ Root, Type }, '8.8.0')

    assert.strictEqual(Root.prototype.load, once)
    assert.notStrictEqual(Type.prototype.fromObject, noop)
  })

  it('patches a distinct pubsub Topic without wrapping a shared Subscription again', () => {
    require('../../src/google-cloud-pubsub')
    const hooks = instrumentations['@google-cloud/pubsub'].filter(({ file }) => !file)
    const first = cases.find(({ name }) => name === '@google-cloud/pubsub').create()
    for (const { hook } of hooks) hook(first, '5.0.0')
    const once = first.Subscription.prototype.emit
    const Topic = withMethods(['publish', 'publishMessage'])
    const original = Topic.prototype.publishMessage

    for (const { hook } of hooks) hook({ ...first, Topic }, '5.0.0')

    assert.strictEqual(first.Subscription.prototype.emit, once)
    assert.notStrictEqual(Topic.prototype.publishMessage, original)
  })

  for (const { name, file, version } of [
    { name: '@azure/functions', file: 'azure-functions', version: '4.10.0' },
    { name: 'durable-functions', file: 'azure-durable-functions', version: '3.5.0' },
  ]) {
    it(`leaves ${name} without an app unchanged`, () => {
      require(`../../src/${file}`)
      const [{ hook }] = instrumentations[name].filter(({ file }) => !file)
      const exports = {}
      assert.strictEqual(hook(exports, version), exports)
    })
  }
})
