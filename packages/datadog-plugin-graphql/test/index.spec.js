'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { performance } = require('perf_hooks')
const { inspect } = require('node:util')

const axios = require('axios')
const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { DD_MAJOR } = require('../../../version')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let tracer
  let graphql
  let schema
  let sort

  let markFast
  let markSlow
  let markSync

  // Mock Mongoose Query that throws if .then() or .exec() is called more than once.
  class Query {
    constructor (value) {
      this._value = value
      this._called = false
    }

    then (onFulfilled, onRejected) {
      if (this._called) {
        throw new Error('This thenable has already been executed.')
      }
      this._called = true
      return Promise.resolve(this._value).then(onFulfilled, onRejected)
    }

    exec () {
      if (this._called) {
        return Promise.reject(new Error('This thenable has already been executed.'))
      }
      this._called = true
      return Promise.resolve(this._value)
    }
  }

  function buildSchema () {
    const Human = new graphql.GraphQLObjectType({
      name: 'Human',
      fields: {
        name: {
          type: graphql.GraphQLString,
          resolve (obj, args) {
            return 'test'
          },
        },
        address: {
          type: new graphql.GraphQLObjectType({
            name: 'Address',
            fields: {
              civicNumber: {
                type: graphql.GraphQLString,
                resolve: () => 123,
              },
              street: {
                type: graphql.GraphQLString,
                resolve: () => 'foo street',
              },
            },
          }),
          resolve (obj, args) {
            return {}
          },
        },
        pets: {
          type: new graphql.GraphQLList(new graphql.GraphQLNonNull(new graphql.GraphQLObjectType({
            name: 'Pet',
            fields: () => ({
              type: {
                type: graphql.GraphQLString,
                resolve: () => 'dog',
              },
              name: {
                type: graphql.GraphQLString,
                resolve: () => 'foo bar',
              },
              owner: {
                type: Human,
                resolve: () => ({}),
              },
              colours: {
                type: new graphql.GraphQLList(new graphql.GraphQLObjectType({
                  name: 'Colour',
                  fields: {
                    code: {
                      type: graphql.GraphQLString,
                      resolve: () => '#ffffff',
                    },
                  },
                })),
                resolve (obj, args) {
                  return [{}, {}]
                },
              },
            }),
          }))),
          resolve (obj, args) {
            return [{}, {}, {}]
          },
        },
        fastAsyncField: {
          type: graphql.GraphQLString,
          resolve (obj, args) {
            return new Promise((resolve) => {
              markFast = performance.now()
              resolve('fast field')
            })
          },
        },
        slowAsyncField: {
          type: graphql.GraphQLString,
          resolve (obj, args) {
            return new Promise((resolve) => {
              markSlow = performance.now()
              resolve('slow field')
            })
          },
        },
        syncField: {
          type: graphql.GraphQLString,
          resolve (obj, args) {
            markSync = performance.now()
            return 'sync field'
          },
        },
        oneTime: {
          type: graphql.GraphQLString,
          resolve: () => new Query('one-time result'),
        },
      },
    })

    schema = new graphql.GraphQLSchema({
      query: new graphql.GraphQLObjectType({
        name: 'RootQueryType',
        fields: {
          hello: {
            type: graphql.GraphQLString,
            args: {
              name: {
                type: graphql.GraphQLString,
              },
              title: {
                type: graphql.GraphQLString,
                defaultValue: null,
              },
            },
            resolve (obj, args) {
              return args.name
            },
          },
          human: {
            type: Human,
            resolve (obj, args) {
              return Promise.resolve({})
            },
          },
          friends: {
            type: new graphql.GraphQLList(Human),
            resolve () {
              return [{ name: 'alice' }, { name: 'bob' }]
            },
          },
        },
      }),

      mutation: new graphql.GraphQLObjectType({
        name: 'RootMutationType',
        fields: {
          human: {
            type: Human,
            resolve () {
              return Promise.resolve({ name: 'human name' })
            },
          },
        },
      }),

      subscription: new graphql.GraphQLObjectType({
        name: 'RootSubscriptionType',
        fields: {
          human: {
            type: Human,
            resolve () {
              return Promise.resolve({ name: 'human name' })
            },
          },
        },
      }),
    })
  }

  describe('graphql', () => {
    withVersions('graphql', 'graphql', (version, moduleName, graphqlVersion) => {
      before(() => {
        sort = spans => spans.sort((a, b) => {
          const order = [
            'graphql.query',
            'graphql.mutation',
            'graphql.subscription',
            'graphql.parse',
            'graphql.validate',
            expectedSchema.server.opName,
            'graphql.field',
            'graphql.resolve',
          ]

          if (a.start.toString() === b.start.toString()) {
            return order.indexOf(a.name) - order.indexOf(b.name)
          }

          return a.start.toString() >= b.start.toString() ? 1 : -1
        })
      })

      describe('graphql-yoga', () => {
        // graphql-yoga 3.x lists graphql as a `^15.2.0 || ^16.0.0` peer and ships no nested copy, so under an
        // older outer graphql version it resolves an incompatible graphql off NODE_PATH and never executes,
        // timing out the assertion. Only register the suite for a graphql release graphql-yoga supports.
        if (!semver.satisfies(graphqlVersion, '^15.2.0 || ^16.0.0')) return

        withVersions('graphql', 'graphql-yoga', version => {
          let graphqlYoga
          let server
          let port

          // A generous hook timeout absorbs the one-off cost of loading the
          // graphql-yoga tree and building the envelop execution pipeline under
          // coverage on CI, keeping the assertion below on a fast hot path.
          before(async function () {
            this.timeout(10000)

            tracer = require('../../dd-trace')
            await agent.load('graphql')

            graphqlYoga = require(`../../../versions/graphql-yoga@${version}`).get()

            const typeDefs = `
              type Query {
                hello(name: String): String
                error: String
              }
              type Subscription {
                count: Int
              }
            `

            const resolvers = {
              Query: {
                hello: (_, { name }) => {
                  return `Hello, ${name || 'world'}!`
                },
                error: async () => {
                  throw new Error('Yoga query failed')
                },
              },
              Subscription: {
                count: {
                  subscribe: async function * () {
                    yield { count: 1 }
                  },
                },
              },
            }

            const schema = graphqlYoga.createSchema({ typeDefs, resolvers })
            const yoga = graphqlYoga.createYoga({ schema })

            server = http.createServer(yoga)
            await new Promise(resolve => server.listen(0, resolve))
            port = (/** @type {import('net').AddressInfo} */ (server.address())).port

            // The first request primes the lazily built execution pipeline so
            // the timed assertion does not race a cold request on CI.
            await axios.post(`http://localhost:${port}/graphql`, {
              query: 'query Warmup { hello(name: "warmup") }',
            })
          })

          after(async () => {
            server.close()
            await agent.close()
          })

          it('should instrument graphql-yoga execution', () => {
            const query = `
              query MyQuery {
                hello(name: "world")
              }
            `

            const assertion = agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                service: expectedSchema.server.serviceName,
                name: expectedSchema.server.opName,
                resource: 'query MyQuery{hello(name:"")}',
                type: 'graphql',
                error: 0,
                meta: {
                  'graphql.operation.type': 'query',
                  'graphql.operation.name': 'MyQuery',
                  component: 'graphql',
                  '_dd.integration': 'graphql',
                },
              })
              assert.ok(!('graphql.source' in spans[0].meta))
              assert.strictEqual(spans.filter(span => span.name === expectedSchema.server.opName).length, 1)
            }, { spanResourceMatch: /MyQuery/ })

            return Promise.all([
              assertion,
              axios.post(`http://localhost:${port}/graphql`, { query }),
            ])
          })

          it('should instrument graphql-yoga async execution errors', () => {
            const query = `
              query ErrorQuery {
                error
              }
            `

            const assertion = agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                name: expectedSchema.server.opName,
                resource: 'query ErrorQuery{error}',
                error: 1,
                meta: {
                  'graphql.operation.type': 'query',
                  'graphql.operation.name': 'ErrorQuery',
                },
              })
            }, { spanResourceMatch: /ErrorQuery/ })

            return Promise.all([
              assertion,
              axios.post(`http://localhost:${port}/graphql`, { query }),
            ])
          })

          it('should instrument graphql-yoga subscriptions', () => {
            const query = `
              subscription CountSubscription {
                count
              }
            `

            const assertion = agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                name: expectedSchema.server.opName,
                resource: 'subscription CountSubscription{count}',
                error: 0,
                meta: {
                  'graphql.operation.type': 'subscription',
                  'graphql.operation.name': 'CountSubscription',
                },
              })
            }, { spanResourceMatch: /CountSubscription/ })

            return Promise.all([
              assertion,
              axios.post(`http://localhost:${port}/graphql`, { query }, {
                headers: {
                  accept: 'text/event-stream',
                },
              }),
            ])
          })
        })
      })

      describe('without configuration', () => {
        before(async () => {
          await agent.load('graphql')
          tracer = require('../../dd-trace')
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        after(() => {
          return agent.close()
        })

        withNamingSchema(
          () => {
            const source = 'query MyQuery { hello(name: "world") }'
            const variableValues = { who: 'world' }
            graphql.graphql({ schema, source, variableValues })
          },
          rawExpectedSchema.server,
          {
            selectSpan: (traces) => {
              const spans = sort(traces[0])
              return spans[0]
            },
          }
        )

        it('should instrument parsing', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }

          const assertion = agent.assertFirstTraceSpan(span => {
            assertObjectContains(span, {
              service: 'test',
              name: 'graphql.parse',
              resource: 'graphql.parse',
              type: 'graphql',
              error: 0,
              meta: { component: 'graphql' },
            })
            assert.ok(!('graphql.source' in span.meta))
          }, { spanResourceMatch: /^graphql\.parse$/ })

          return Promise.all([assertion, graphql.graphql({ schema, source, variableValues })])
        })

        it('should instrument validation', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }

          const assertion = agent.assertFirstTraceSpan(span => {
            assertObjectContains(span, {
              service: 'test',
              name: 'graphql.validate',
              resource: 'graphql.validate',
              type: 'graphql',
              error: 0,
              meta: { component: 'graphql' },
            })
            assert.ok(!('graphql.source' in span.meta))
          }, { spanResourceMatch: /^graphql\.validate$/ })

          return Promise.all([assertion, graphql.graphql({ schema, source, variableValues })])
        })

        it('should instrument execution', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assertObjectContains(spans[0], {
              service: expectedSchema.server.serviceName,
              name: expectedSchema.server.opName,
              resource: 'query MyQuery{hello(name:"")}',
              type: 'graphql',
              error: 0,
              meta: {
                'graphql.operation.type': 'query',
                'graphql.operation.name': 'MyQuery',
                component: 'graphql',
              },
            })
            assert.ok(!('graphql.source' in spans[0].meta))
          }, { spanResourceMatch: /MyQuery/ })

          return Promise.all([assertion, graphql.graphql({ schema, source, variableValues })])
        })

        it('should instrument every execute even when the args object is reused', async () => {
          const startChannel = dc.channel('apm:graphql:execute:start')
          const document = graphql.parse('query MyQuery { hello(name: "world") }')
          const args = { schema, document, contextValue: {} }

          let starts = 0
          const handler = () => { starts++ }
          startChannel.subscribe(handler)

          try {
            await graphql.execute(args)
            await graphql.execute(args)
            assert.strictEqual(starts, 2)
          } finally {
            startChannel.unsubscribe(handler)
          }
        })

        it('should not add fieldResolver to a frozen caller-owned execute args object', async () => {
          const document = graphql.parse('query MyQuery { hello(name: "world") }')
          const args = Object.freeze({ schema, document, contextValue: {} })

          assert.ok(await graphql.execute(args), 'execute returned a result')
          assert.ok(!Object.hasOwn(args, 'fieldResolver'),
            'instrumentation must not add fieldResolver to caller args')
        })

        it('should not overwrite the caller-supplied fieldResolver on the execute args object', async () => {
          const document = graphql.parse('query MyQuery { hello(name: "world") }')
          const callerFieldResolver = (source, args, contextValue, info) => 'caller-resolved'
          const args = { schema, document, contextValue: {}, fieldResolver: callerFieldResolver }

          assert.ok(await graphql.execute(args), 'execute returned a result')
          assert.strictEqual(args.fieldResolver, callerFieldResolver,
            'instrumentation must not overwrite the caller-supplied fieldResolver')
        })

        it('should preserve graphql defaultFieldResolver behavior for primitive sources', async () => {
          const Box = new graphql.GraphQLObjectType({
            name: 'Box',
            fields: {
              length: {
                type: graphql.GraphQLInt,
              },
            },
          })
          const query = new graphql.GraphQLObjectType({
            name: 'Query',
            fields: {
              box: {
                type: Box,
                resolve: () => 'abc',
              },
            },
          })
          const localSchema = new graphql.GraphQLSchema({ query })
          const document = graphql.parse('{ box { length } }')

          const result = await graphql.execute({ schema: localSchema, document })

          assert.strictEqual(result.data.box.length, null)
        })

        it('publishes caller-owned execute args before installing the wrapped fieldResolver', async () => {
          const startChannel = dc.channel('apm:graphql:execute:start')
          const document = graphql.parse('query MyQuery { hello(name: "world") }')
          const callerFieldResolver = (source, args, contextValue, info) => 'caller-resolved'
          const args = { schema, document, contextValue: {}, fieldResolver: callerFieldResolver }

          let publishedArgs
          const handler = ({ args: channelArgs }) => {
            publishedArgs = channelArgs
            assert.strictEqual(channelArgs, args)
            assert.strictEqual(channelArgs.fieldResolver, callerFieldResolver)
          }
          startChannel.subscribe(handler)

          try {
            assert.ok(await graphql.execute(args), 'execute returned a result')
          } finally {
            startChannel.unsubscribe(handler)
          }

          assert.strictEqual(publishedArgs, args)
          assert.strictEqual(args.fieldResolver, callerFieldResolver)
        })

        describe('preserves the caller-supplied contextValue', () => {
          let recordingSchema
          let recordedContext

          beforeEach(() => {
            recordedContext = []
            recordingSchema = new graphql.GraphQLSchema({
              query: new graphql.GraphQLObjectType({
                name: 'Query',
                fields: {
                  ctx: {
                    type: graphql.GraphQLString,
                    resolve: (_source, _args, contextValue) => {
                      recordedContext.push(contextValue)
                      return 'ok'
                    },
                  },
                },
              }),
            })
          })

          for (const contextValue of [false, 0, '', null, undefined, 42, 'request-1', Symbol('ctx')]) {
            const label = String(contextValue) || typeof contextValue

            it(`forwards ${label} to resolvers (object form)`, async () => {
              const document = graphql.parse('{ ctx }')

              const result = await graphql.execute({ schema: recordingSchema, document, contextValue })

              assert.strictEqual(result.data?.ctx, 'ok')
              assert.strictEqual(recordedContext.length, 1)
              assert.strictEqual(recordedContext[0], contextValue,
                'resolver must receive the caller-supplied contextValue unchanged')
            })

            // graphql >=16 dropped positional execute(); see PR 2904 below.
            if (!semver.intersects(version, '>=16')) {
              it(`forwards ${label} to resolvers (positional form)`, async () => {
                const document = graphql.parse('{ ctx }')

                const result = await graphql.execute(recordingSchema, document, undefined, contextValue)

                assert.strictEqual(result.data?.ctx, 'ok')
                assert.strictEqual(recordedContext.length, 1)
                assert.strictEqual(recordedContext[0], contextValue,
                  'resolver must receive the caller-supplied contextValue unchanged')
              })
            }
          }

          it('emits the execute span for a primitive contextValue', () => {
            const assertion = agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              assertObjectContains(spans[0], {
                name: expectedSchema.server.opName,
                error: 0,
              })
            }, { spanResourceMatch: /ctx:String/ })

            return Promise.all([assertion, Promise.resolve(graphql.execute({
              schema: recordingSchema,
              document: graphql.parse('{ ctx }'),
              contextValue: 'request-1',
            }))])
          })

          it('emits resolver spans for a primitive contextValue', () => {
            const assertion = agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              const resolveSpan = spans.find(span => span.name === 'graphql.resolve')
              assert.ok(resolveSpan, 'graphql.resolve span should be emitted')
              assert.strictEqual(resolveSpan.meta['graphql.field.name'], 'ctx')
            })

            return Promise.all([assertion, Promise.resolve(graphql.execute({
              schema: recordingSchema,
              document: graphql.parse('{ ctx }'),
              contextValue: 42,
            }))])
          })
        })

        it('should not include variables by default', () => {
          const source = 'query MyQuery($who: String!) { hello(name: $who) }'
          const variableValues = { who: 'world' }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])
            assert.ok(!('graphql.variables' in spans[0].meta))
          })

          return Promise.all([assertion, graphql.graphql({ schema, source, variableValues })])
        })

        it('should instrument schema resolvers', () => {
          const source = '{ hello(name: "world") }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assertObjectContains(spans[1], {
              service: 'test',
              name: 'graphql.resolve',
              resource: 'hello:String',
              type: 'graphql',
              error: 0,
              meta: {
                'graphql.field.name': 'hello',
                'graphql.field.path': 'hello',
                'graphql.field.type': 'String',
                component: 'graphql',
              },
            })
            assert.ok(Number(spans[1].duration) > 0, `Expected ${Number(spans[1].duration)} > 0`)
            assert.ok(!('graphql.source' in spans[1].meta))
          }, { spanResourceMatch: /hello:String/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should trace aliased __proto__ fields with default collapsing', async () => {
          const source = '{ hello(name: "world") __proto__: hello(name: "alias") }'

          const [, result] = await Promise.all([
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              const resolveSpans = spans.filter(span => span.name === 'graphql.resolve')

              assert.strictEqual(resolveSpans.length, 2)

              const paths = resolveSpans
                .map(span => span.meta['graphql.field.path'])
                .sort()

              assert.deepStrictEqual(paths, ['__proto__', 'hello'])

              for (const span of resolveSpans) {
                assert.strictEqual(span.error, 0)
                assert.strictEqual(span.resource, 'hello:String')
              }
            }),
            graphql.graphql({ schema, source }),
          ])

          assert.ok(
            !result.errors || result.errors.length === 0,
            `Got errors: ${inspect(result.errors)}`
          )
          assert.strictEqual(result.data.hello, 'world')
          // eslint-disable-next-line no-proto
          assert.strictEqual(result.data.__proto__, 'alias')
        })

        it('should instrument each field resolver duration independently', done => {
          const source = `
            {
              human {
                fastAsyncField
                slowAsyncField
                syncField
              }
            }
          `

          let foundFastFieldSpan = false
          let foundSlowFieldSpan = false
          let foundSyncFieldSpan = false

          let fastAsyncTime
          let slowAsyncTime
          let syncTime

          const processTraces = (traces) => {
            try {
              for (const trace of traces) {
                for (const span of trace) {
                  if (span.name !== 'graphql.resolve') {
                    continue
                  }

                  if (span.resource === 'fastAsyncField:String') {
                    assert.ok(fastAsyncTime < slowAsyncTime, `Expected ${fastAsyncTime} < ${slowAsyncTime}`)
                    foundFastFieldSpan = true
                  } else if (span.resource === 'slowAsyncField:String') {
                    assert.ok(slowAsyncTime < syncTime, `Expected ${slowAsyncTime} < ${syncTime}`)
                    foundSlowFieldSpan = true
                  } else if (span.resource === 'syncField:String') {
                    assert.ok(syncTime > slowAsyncTime, `Expected ${syncTime} > ${slowAsyncTime}`)
                    foundSyncFieldSpan = true
                  }

                  if (foundFastFieldSpan && foundSlowFieldSpan && foundSyncFieldSpan) {
                    agent.unsubscribe(processTraces)
                    done()
                    return
                  }
                }
              }
            } catch (e) {
              agent.unsubscribe(processTraces)
              done(e)
            }
          }

          agent.subscribe(processTraces)

          const markStart = performance.now()

          graphql.graphql({ schema, source })
            .then((result) => {
              fastAsyncTime = markFast - markStart
              slowAsyncTime = markSlow - markStart
              syncTime = markSync - markStart
            })
            .catch((e) => {
              agent.unsubscribe(processTraces)
              done(e)
            })
        })

        it('should instrument nested field resolvers', () => {
          const source = `
            {
              human {
                name
                address {
                  civicNumber
                  street
                }
              }
            }
          `

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])
            assert.strictEqual(spans.length, 6)

            const execute = spans[0]
            const human = spans[1]
            const humanName = spans[2]
            const address = spans[3]
            const addressCivicNumber = spans[4]
            const addressStreet = spans[5]

            assertObjectContains(execute, {
              name: expectedSchema.server.opName,
              error: 0,
            })

            assertObjectContains(human, {
              name: 'graphql.resolve',
              resource: 'human:Human',
              error: 0,
              meta: {
                'graphql.field.path': 'human',
              },
            })
            assert.strictEqual(human.parent_id.toString(), execute.span_id.toString())

            assertObjectContains(humanName, {
              name: 'graphql.resolve',
              resource: 'name:String',
              error: 0,
              meta: {
                'graphql.field.path': 'human.name',
              },
            })
            assert.strictEqual(humanName.parent_id.toString(), human.span_id.toString())

            assertObjectContains(address, {
              name: 'graphql.resolve',
              resource: 'address:Address',
              error: 0,
              meta: {
                'graphql.field.path': 'human.address',
              },
            })
            assert.strictEqual(address.parent_id.toString(), human.span_id.toString())

            assertObjectContains(addressCivicNumber, {
              name: 'graphql.resolve',
              resource: 'civicNumber:String',
              error: 0,
              meta: {
                'graphql.field.path': 'human.address.civicNumber',
              },
            })
            assert.strictEqual(addressCivicNumber.parent_id.toString(), address.span_id.toString())

            assertObjectContains(addressStreet, {
              name: 'graphql.resolve',
              resource: 'street:String',
              error: 0,
              meta: {
                'graphql.field.path': 'human.address.street',
              },
            })
            assert.strictEqual(addressStreet.parent_id.toString(), address.span_id.toString())
          }, { spanResourceMatch: /human:Human/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('publishes resolver finish for every sibling of a collapsed list', async () => {
          // Regression for first-wins finishTime: when a list collapses to one span,
          // every sibling resolver must still publish on apm:graphql:resolve:updateField
          // so the span's finishTime reflects the last sibling, not the first.
          const updateCh = dc.channel('apm:graphql:resolve:updateField')
          const counts = new Map()
          const handler = (ctx) => {
            counts.set(ctx.pathString, (counts.get(ctx.pathString) ?? 0) + 1)
          }
          updateCh.subscribe(handler)

          try {
            const source = '{ friends { name } }'
            const [, result] = await Promise.all([
              agent.assertSomeTraces(traces => {
                const spans = sort(traces[0]).filter(span => span.name === 'graphql.resolve')
                const friendsName = spans.find(span => span.meta['graphql.field.path'] === 'friends.*.name')
                assert.ok(friendsName, 'expected one collapsed friends.*.name span')
              }),
              graphql.graphql({ schema, source }),
            ])

            assert.ok(!result.errors || result.errors.length === 0, `Expected [${result.errors}] to be empty`)
            assert.strictEqual(
              counts.get('friends.*.name'),
              2,
              'expected one updateField publish per sibling of the 2-element friends list',
            )
          } finally {
            updateCh.unsubscribe(handler)
          }
        })

        it('publishes apm:graphql:resolve:start for every sibling of a collapsed list', async () => {
          // The collapse knob dedupes span creation, not channel publishes. IAST
          // taint-tracking mutates each call's own args object; if siblings 2..N
          // skip the publish, those args objects never get tainted and a sink
          // reached through sibling N misses the vulnerability.
          const startCh = dc.channel('apm:graphql:resolve:start')
          const argsByPath = new Map()
          const handler = (ctx) => {
            const list = argsByPath.get(ctx.pathString) ?? []
            list.push(ctx.args)
            argsByPath.set(ctx.pathString, list)
          }
          startCh.subscribe(handler)

          try {
            const source = '{ friends { name } }'
            const [, result] = await Promise.all([
              agent.assertSomeTraces(traces => {
                const spans = sort(traces[0]).filter(span => span.name === 'graphql.resolve')
                const friendsName = spans.find(span => span.meta['graphql.field.path'] === 'friends.*.name')
                assert.ok(friendsName, 'expected one collapsed friends.*.name span')
              }),
              graphql.graphql({ schema, source }),
            ])

            assert.ok(!result.errors || result.errors.length === 0, `Expected [${result.errors}] to be empty`)
            const nameArgs = argsByPath.get('friends.*.name') ?? []
            assert.strictEqual(
              nameArgs.length,
              2,
              'expected one startResolveCh publish per sibling of the 2-element friends list',
            )
            // graphql-js builds a fresh args object per resolver call; siblings
            // share content but not identity. IAST mutates the passed object, so
            // each call needs its own publish.
            assert.notStrictEqual(nameArgs[0], nameArgs[1])
          } finally {
            startCh.unsubscribe(handler)
          }
        })

        it('parents user spans from every sibling of a collapsed list under a live span', async () => {
          const Item = new graphql.GraphQLObjectType({
            name: 'Item',
            fields: {
              name: {
                type: graphql.GraphQLString,
                resolve () {
                  tracer.trace('user.work', () => {})
                  return 'value'
                },
              },
            },
          })
          const localSchema = new graphql.GraphQLSchema({
            query: new graphql.GraphQLObjectType({
              name: 'Query',
              fields: {
                items: {
                  type: new graphql.GraphQLList(Item),
                  resolve: () => [{}, {}],
                },
              },
            }),
          })

          const [, result] = await Promise.all([
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              const collapsed = spans.find(span => span.meta?.['graphql.field.path'] === 'items.*.name')
              const userSpans = spans.filter(span => span.name === 'user.work')
              const byId = new Map(spans.map(span => [span.span_id.toString(), span]))

              assert.ok(collapsed, 'expected one collapsed items.*.name span')
              assert.strictEqual(userSpans.length, 2, 'expected one user span per sibling resolver')

              for (const userSpan of userSpans) {
                const parent = byId.get(userSpan.parent_id.toString())
                assert.ok(parent, 'user span must parent to a span in the same trace, not an orphaned closed span')
                const parentStart = BigInt(parent.start)
                const parentEnd = parentStart + BigInt(parent.duration)
                const childStart = BigInt(userSpan.start)
                const childEnd = childStart + BigInt(userSpan.duration)
                assert.ok(
                  childStart >= parentStart && childEnd <= parentEnd,
                  'user span must be contained within its live parent, not start after it finished',
                )
              }
            }, { spanResourceMatch: /items:\[Item]/ }),
            graphql.graphql({ schema: localSchema, source: '{ items { name } }' }),
          ])

          assert.ok(!('errors' in result), `Unexpected per-field errors: ${JSON.stringify(result.errors)}`)
        })

        it('should instrument list field resolvers', () => {
          const source = `{
            friends {
              name
              pets {
                name
              }
            }
          }`

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 5)

            const execute = spans[0]
            const friends = spans[1]
            const friendsName = spans[2]
            const pets = spans[3]
            const petsName = spans[4]

            assert.strictEqual(execute.name, expectedSchema.server.opName)

            assertObjectContains(friends, {
              name: 'graphql.resolve',
              resource: 'friends:[Human]',
              meta: {
                'graphql.field.path': 'friends',
                'graphql.field.type': 'Human',
              },
            })
            assert.strictEqual(friends.parent_id.toString(), execute.span_id.toString())

            assertObjectContains(friendsName, {
              name: 'graphql.resolve',
              resource: 'name:String',
              meta: {
                'graphql.field.path': 'friends.*.name',
                'graphql.field.type': 'String',
              },
            })
            assert.strictEqual(friendsName.parent_id.toString(), friends.span_id.toString())

            assertObjectContains(pets, {
              name: 'graphql.resolve',
              resource: 'pets:[Pet!]',
              meta: {
                'graphql.field.path': 'friends.*.pets',
                'graphql.field.type': 'Pet',
              },
            })
            assert.strictEqual(pets.parent_id.toString(), friends.span_id.toString())

            assertObjectContains(petsName, {
              name: 'graphql.resolve',
              resource: 'name:String',
              meta: {
                'graphql.field.path': 'friends.*.pets.*.name',
                'graphql.field.type': 'String',
              },
            })
            assert.strictEqual(petsName.parent_id.toString(), pets.span_id.toString())
          }, { spanResourceMatch: /friends:\[Human]/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('caches path strings across nested list-of-lists items', async () => {
          // `[[Cell]]` puts two synthetic array-index nodes back-to-back; the
          // `friends { pets { name } }` sibling has a `pets` field between.
          const matrixSchema = graphql.buildSchema(`
            type Cell { value: Int }
            type Query { matrix: [[Cell]] }
          `)
          const rootValue = { matrix: () => [[{ value: 42 }]] }
          const source = '{ matrix { value } }'

          const [, result] = await Promise.all([
            agent.assertSomeTraces(traces => {
              const resolveSpans = sort(traces[0]).filter(span => span.name === 'graphql.resolve')
              const paths = resolveSpans.map(span => span.meta['graphql.field.path']).sort()
              assert.deepStrictEqual(paths, ['matrix', 'matrix.*.*.value'])

              const matrix = resolveSpans.find(span => span.meta['graphql.field.path'] === 'matrix')
              const value = resolveSpans.find(span => span.meta['graphql.field.path'] === 'matrix.*.*.value')
              assert.ok(matrix, 'expected matrix span')
              assert.ok(value, 'expected matrix.*.*.value span')
              assert.strictEqual(value.parent_id.toString(), matrix.span_id.toString())
            }),
            graphql.graphql({ schema: matrixSchema, source, rootValue }),
          ])

          assert.ok(!result.errors || result.errors.length === 0)
          assert.strictEqual(result.data?.matrix?.[0]?.[0]?.value, 42)
        })

        it('should instrument mutations', () => {
          const source = 'mutation { human { name } }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans[0].meta['graphql.operation.type'], 'mutation')
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should instrument subscriptions', () => {
          const source = 'subscription { human { name } }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans[0].meta['graphql.operation.type'], 'subscription')
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should handle a circular schema', async () => {
          const source = '{ human { pets { owner { name } } } }'

          const result = await graphql.graphql({ schema, source })
          assert.strictEqual(result.data.human.pets[0].owner.name, 'test')
        })

        it('should instrument the default field resolver', () => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'
          const rootValue = { hello: 'world' }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
            assert.strictEqual(spans[1].name, 'graphql.resolve')
          })

          return Promise.all([assertion, graphql.graphql({ schema, source, rootValue })])
        })

        it('should instrument the execution field resolver without a rootValue resolver', () => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = { hello: 'world' }

          const fieldResolver = (source, args, contextValue, info) => {
            return source[info.fieldName]
          }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
            assert.strictEqual(spans[1].name, 'graphql.resolve')
          })

          return Promise.all([assertion, graphql.graphql({ schema, source, rootValue, fieldResolver })])
        })

        it('should not instrument schema resolvers multiple times', () => {
          const source = '{ hello(name: "world") }'

          const assertion = agent.assertSomeTraces(() => { // skip first call
            const secondAssertion = agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
            })

            return Promise.all([secondAssertion, graphql.graphql({ schema, source })])
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should run parsing, validation and execution in the current context', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }
          const span = tracer.startSpan('test.request')

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 5)

            assert.strictEqual(spans[0].name, 'test.request')

            assertObjectContains(spans[1], {
              service: 'test',
              name: 'graphql.parse',
            })

            assertObjectContains(spans[2], {
              service: 'test',
              name: 'graphql.validate',
            })

            assertObjectContains(spans[3], {
              service: expectedSchema.server.serviceName,
              name: expectedSchema.server.opName,
              resource: 'query MyQuery{hello(name:"")}',
            })

            assertObjectContains(spans[4], {
              service: 'test',
              name: 'graphql.resolve',
              resource: 'hello:String',
            })
          }, { spanResourceMatch: /test\.request/ })

          const action = tracer.scope().activate(span, () => {
            return graphql.graphql({ schema, source, variableValues }).then(() => span.finish())
          })

          return Promise.all([assertion, action])
        })

        it('should run rootValue resolvers in the current context', done => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = {
            hello () {
              try {
                assert.notStrictEqual(tracer.scope().active(), null)
                done()
              } catch (e) {
                done(e)
              }
            },
          }

          graphql.graphql({ schema, source, rootValue }).catch(done)
        })

        it('should make the resolve span the active scope inside resolvers', async () => {
          const localSchema = graphql.buildSchema(`
            type Query { outer: Outer }
            type Outer { inner: String }
          `)

          const captures = {}
          const captureActive = label => {
            const span = tracer.scope().active()
            captures[label] = {
              name: span?.context()._name,
              resource: span?.context().getTag('resource.name'),
            }
          }

          const rootValue = {
            outer () {
              captureActive('outer')
              return {
                inner () {
                  captureActive('inner')
                  return 'value'
                },
              }
            },
          }

          const result = await graphql.graphql({
            schema: localSchema,
            source: '{ outer { inner } }',
            rootValue,
          })

          assert.strictEqual(result.data?.outer?.inner, 'value')
          assert.deepStrictEqual(captures, {
            outer: { name: 'graphql.resolve', resource: 'outer:Outer' },
            inner: { name: 'graphql.resolve', resource: 'inner:String' },
          })
        })

        it('should run returned promise in the parent context', () => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = {
            hello () {
              return Promise.resolve('test')
            },
          }

          const span = tracer.startSpan('test')

          return tracer.scope().activate(span, () => {
            return graphql.graphql({ schema, source, rootValue })
              .then(value => {
                assert.strictEqual(value?.data?.hello, 'test')
                assert.strictEqual(tracer.scope().active(), span)
              })
          })
        })

        it('should handle unsupported operations', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const subscription = 'subscription { human { name } }'

          return graphql.graphql({ schema, source })
            .then(() => graphql.graphql({ schema, source: subscription }))
            .then(result => {
              assert.ok(!('errors' in result))
            })
        })

        it('should handle calling low level APIs directly', () => {
          const source = 'query MyQuery { hello(name: "world") }'

          const assertion = Promise.all([
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              assert.strictEqual(spans[0].name, 'graphql.parse')
            }),
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              assert.strictEqual(spans[0].name, 'graphql.validate')
            }),
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[1].name, 'graphql.resolve')
            }),
          ])

          // These are the 3 lower-level steps
          const document = graphql.parse(source)
          graphql.validate(schema, document)
          graphql.execute({ schema, document })

          return assertion
        })

        it('should not re-execute thenables from resolvers', async () => {
          const source = '{ human { oneTime } }'

          const result = await graphql.graphql({ schema, source })
          assert.ok(!('errors' in result))
          assert.strictEqual(result.data.human.oneTime, 'one-time result')
        })

        it('should handle Source objects', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const document = graphql.parse(new graphql.Source(source))

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assertObjectContains(spans[0], {
              service: expectedSchema.server.serviceName,
              name: expectedSchema.server.opName,
              resource: 'query MyQuery{hello(name:"")}',
              meta: { component: 'graphql' },
            })
            assert.ok(!('graphql.source' in spans[0].meta))
          }, { spanResourceMatch: /MyQuery/ })

          graphql.execute({ schema, document })

          return assertion
        })

        it('should handle parsing exceptions', () => {
          let error

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].service, 'test')
            assert.strictEqual(spans[0].name, 'graphql.parse')
            assert.strictEqual(spans[0].error, 1)
            assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
            assert.strictEqual(spans[0].meta.component, 'graphql')
          })

          try {
            graphql.parse('invalid')
          } catch (e) {
            error = e
          }

          return assertion
        })

        it('should handle validation exceptions', () => {
          let error

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].service, 'test')
            assert.strictEqual(spans[0].name, 'graphql.validate')
            assert.strictEqual(spans[0].error, 1)
            assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
            assert.strictEqual(spans[0].meta.component, 'graphql')
          })

          try {
            graphql.validate()
          } catch (e) {
            error = e
          }

          return assertion
        })

        it('should handle validation errors', () => {
          const source = '{ human { address } }'
          const document = graphql.parse(source)

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].service, 'test')
            assert.strictEqual(spans[0].name, 'graphql.validate')
            assert.strictEqual(spans[0].error, 1)
            assert.strictEqual(spans[0].meta[ERROR_TYPE], errors[0].name)
            assert.strictEqual(spans[0].meta[ERROR_MESSAGE], errors[0].message)
            assert.strictEqual(spans[0].meta[ERROR_STACK], errors[0].stack)
            assert.strictEqual(spans[0].meta.component, 'graphql')

            const spanEvents = agent.unformatSpanEvents(spans[0])

            assert.strictEqual(spanEvents.length, 1)
            assert.ok(('startTime' in spanEvents[0]))
            assert.strictEqual(spanEvents[0].name, 'dd.graphql.query.error')
            assert.strictEqual(spanEvents[0].attributes.type, 'GraphQLError')
            assert.ok(
              !Object.hasOwn(spanEvents[0].attributes, 'stacktrace'),
              `Available keys: ${inspect(Object.keys(spanEvents[0].attributes))}`
            )
            assert.strictEqual(spanEvents[0].attributes.message, 'Field "address" of ' +
              'type "Address" must have a selection of subfields. Did you mean "address { ... }"?')
            assert.strictEqual(spanEvents[0].attributes.locations.length, 1)
            assert.strictEqual(spanEvents[0].attributes.locations[0], '1:11')
          })

          const errors = graphql.validate(schema, document)

          return assertion
        })

        it('should handle execution exceptions', () => {
          const source = '{ hello }'
          const document = graphql.parse(source)

          let error

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].service, expectedSchema.server.serviceName)
            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
            assert.strictEqual(spans[0].error, 1)
            assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
            assert.strictEqual(spans[0].meta.component, 'graphql')
          })

          try {
            graphql.execute(null, document)
          } catch (e) {
            error = e
          }

          return assertion
        })

        it('should handle execution errors', () => {
          const source = '{ hello }'
          const document = graphql.parse(source)

          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const rootValue = {
            hello: () => {
              throw new Error('test')
            },
          }

          let error

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assert.strictEqual(spans[0].service, expectedSchema.server.serviceName)
            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
            assert.strictEqual(spans[0].error, 1)
            assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
            assert.strictEqual(spans[0].meta.component, 'graphql')

            const spanEvents = agent.unformatSpanEvents(spans[0])

            assert.strictEqual(spanEvents.length, 1)
            assert.ok(
              Object.hasOwn(spanEvents[0], 'startTime'),
              `Available keys: ${inspect(Object.keys(spanEvents[0]))}`
            )
            assert.strictEqual(spanEvents[0].name, 'dd.graphql.query.error')
            assert.strictEqual(spanEvents[0].attributes.type, 'GraphQLError')
            assert.ok(
              Object.hasOwn(spanEvents[0].attributes, 'stacktrace'),
              `Available keys: ${inspect(Object.keys(spanEvents[0].attributes))}`
            )
            assert.strictEqual(spanEvents[0].attributes.message, 'test')
            assert.strictEqual(spanEvents[0].attributes.locations.length, 1)
            assert.strictEqual(spanEvents[0].attributes.locations[0], '1:3')
            assert.strictEqual(spanEvents[0].attributes.path.length, 1)
            assert.strictEqual(spanEvents[0].attributes.path[0], 'hello')
          })

          const action = Promise.resolve(graphql.execute({ schema, document, rootValue }))
            .then(res => {
              error = res.errors[0]
            })

          return Promise.all([assertion, action])
        })

        it('should handle resolver exceptions', () => {
          const error = new Error('test')

          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = {
            hello: () => {
              throw error
            },
          }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assert.strictEqual(spans[1].error, 1)
            assert.strictEqual(spans[1].meta[ERROR_TYPE], error.name)
            assert.strictEqual(spans[1].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(spans[1].meta[ERROR_STACK], error.stack)
            assert.strictEqual(spans[1].meta.component, 'graphql')
          })

          return Promise.all([assertion, graphql.graphql({ schema, source, rootValue })])
        })

        it('should handle rejected promises', () => {
          const error = new Error('test')

          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = {
            hello: () => {
              return Promise.reject(error)
            },
          }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assert.strictEqual(spans[1].error, 1)
            assert.strictEqual(spans[1].meta[ERROR_TYPE], error.name)
            assert.strictEqual(spans[1].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(spans[1].meta[ERROR_STACK], error.stack)
            assert.strictEqual(spans[1].meta.component, 'graphql')
          })

          return Promise.all([assertion, graphql.graphql({ schema, source, rootValue })])
        })

        it('throws AbortError when the execute abortController is aborted before execute runs', async () => {
          // AppSec's WAF blocks a malicious request by aborting the execute ctx
          // on apm:graphql:execute:start. callInAsyncScope sees the signal and
          // throws AbortError before exe runs; the field-resolver path never
          // fires for this query.
          const startCh = dc.channel('apm:graphql:execute:start')
          const handler = (ctx) => {
            ctx.abortController.abort()
          }
          startCh.subscribe(handler)

          const source = '{ hello(name: "world") }'
          const document = graphql.parse(source)

          try {
            const [, error] = await Promise.all([
              agent.assertSomeTraces(traces => {
                const spans = sort(traces[0])
                const resolveSpans = spans.filter(span => span.name === 'graphql.resolve')
                assert.strictEqual(resolveSpans.length, 0, 'no resolver should run after abort')
                const opSpan = spans.find(span => span.name === expectedSchema.server.opName)
                assert.ok(opSpan, 'execute span still finishes')
                assert.strictEqual(opSpan.error, 0)
              }),
              assert.throws(
                () => graphql.execute({ schema, document }),
                { name: 'AbortError', message: 'Aborted' },
              ),
            ])
            assert.strictEqual(error, undefined)
          } finally {
            startCh.unsubscribe(handler)
          }
        })

        it('throws AbortError from the next resolver when the controller aborts mid-execution', async () => {
          // Same WAF hook as above, but the abort lands after the first
          // resolver finished its work (apm:graphql:resolve:updateField) so
          // callInAsyncScope's signal check is already past. resolveAsync's
          // own signal check is the only guard that stops the second
          // resolver from running, and assertField has already published its
          // startResolveCh / built its TrackedField for it.
          const updateCh = dc.channel('apm:graphql:resolve:updateField')
          const finished = []
          const handler = (ctx) => {
            finished.push(ctx.pathString)
            if (finished.length === 1) {
              ctx.rootCtx.abortController.abort()
            }
          }
          updateCh.subscribe(handler)

          try {
            const source = '{ first: hello(name: "first") second: hello(name: "second") }'
            const result = await graphql.graphql({ schema, source })

            // graphql captures the resolver throw into result.errors; the
            // first resolver runs to completion, the second hits the abort
            // branch.
            assert.ok(result.errors, 'expected an AbortError surfaced through result.errors')
            assert.strictEqual(result.errors.length, 1)
            assert.strictEqual(result.errors[0].originalError?.name, 'AbortError')
            assert.strictEqual(result.errors[0].originalError?.message, 'Aborted')
            assert.deepStrictEqual(finished.sort(), ['first', 'second'])
          } finally {
            updateCh.unsubscribe(handler)
          }
        })

        it('should support multiple executions with the same contextValue', async () => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = {
            hello: () => 'world',
          }

          const contextValue = {}

          await graphql.graphql({ schema, source, rootValue, contextValue })
          await graphql.graphql({ schema, source, rootValue, contextValue })
        })

        it('should support multiple executions on a pre-parsed document', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const document = graphql.parse(source)
          graphql.execute({ schema, document })
          graphql.execute({ schema, document })
        })

        it('should not fail without directives in the document ' +
          'and with subscription to datadog:graphql:resolver:start', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const document = graphql.parse(source)
          delete document.definitions[0].directives
          delete document.definitions[0].selectionSet.selections[0].directives

          function noop () {}
          dc.channel('datadog:graphql:resolver:start').subscribe(noop)

          try {
            graphql.execute({ schema, document })
          } finally {
            dc.channel('datadog:graphql:resolver:start').unsubscribe(noop)
          }
        })

        it('should publish empty resolver args with subscription to datadog:graphql:resolver:start', async () => {
          const source = 'query MyQuery { human { name } }'
          const document = graphql.parse(source)
          const resolverInfo = []

          const handler = ({ resolverInfo: info }) => {
            resolverInfo.push(info)
          }
          dc.channel('datadog:graphql:resolver:start').subscribe(handler)

          try {
            await graphql.execute({ schema, document })
          } finally {
            dc.channel('datadog:graphql:resolver:start').unsubscribe(handler)
          }

          const humanResolverInfo = resolverInfo.find(info => info?.human)
          assert.deepStrictEqual(humanResolverInfo, { human: {} },
            `Expected empty human resolver args. Got ${inspect(resolverInfo)}`)
        })

        it('should support multiple validations on a pre-parsed document', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const document = graphql.parse(source)

          graphql.validate(schema, document)
          graphql.validate(schema, document)
        })

        it('should support multi-operations documents', () => {
          const source = `
            query FirstQuery { hello(name: "world") }
            query SecondQuery { hello(name: "world") }
          `

          const operationName = 'SecondQuery'
          const variableValues = { who: 'world' }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assertObjectContains(spans[0], {
              service: expectedSchema.server.serviceName,
              name: expectedSchema.server.opName,
              resource: 'query SecondQuery{hello(name:"")}',
              meta: {
                'graphql.operation.type': 'query',
                'graphql.operation.name': 'SecondQuery',
                component: 'graphql',
              },
            })
            assert.ok(!('graphql.source' in spans[0].meta))
          }, { spanResourceMatch: /SecondQuery/ })

          return Promise.all([assertion, graphql.graphql({ schema, source, variableValues, operationName })])
        })

        it('should include used fragments in the source', () => {
          const source = `
            query WithFragments {
              human {
                ...firstFields
              }
            }
            fragment firstFields on Human {
              name
            }
          `

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            const resource = 'query WithFragments{human{...firstFields}}fragment firstFields on Human{name}'

            assertObjectContains(spans[0], {
              service: 'test',
              name: expectedSchema.server.opName,
              resource,
              meta: {
                'graphql.operation.type': 'query',
                'graphql.operation.name': 'WithFragments',
                component: 'graphql',
              },
            })
            assert.ok(!('graphql.source' in spans[0].meta))
          }, { spanResourceMatch: /WithFragments/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should handle single fragment definitions', () => {
          const source = `
            fragment firstFields on Human {
              name
            }
          `

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assertObjectContains(spans[0], {
              service: 'test',
              name: 'graphql.parse',
              resource: 'graphql.parse',
              meta: { component: 'graphql' },
            })
            assert.ok(!('graphql.source' in spans[0].meta))
            assert.ok(!('graphql.operation.type' in spans[0].meta))
            assert.ok(!('graphql.operation.name' in spans[0].meta))
          }, { spanResourceMatch: /^graphql\.parse$/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        // https://github.com/graphql/graphql-js/pull/2904
        if (!semver.intersects(version, '>=16')) {
          it('should instrument using positional arguments', () => {
            const source = 'query MyQuery { hello(name: "world") }'
            const variableValues = { who: 'world' }

            const assertion = agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                service: expectedSchema.server.serviceName,
                name: expectedSchema.server.opName,
                resource: 'query MyQuery{hello(name:"")}',
                type: 'graphql',
                meta: {
                  'graphql.operation.type': 'query',
                  'graphql.operation.name': 'MyQuery',
                  component: 'graphql',
                },
              })
              assert.ok(!('graphql.source' in spans[0].meta))
            }, { spanResourceMatch: /MyQuery/ })

            return Promise.all([assertion, graphql.graphql(schema, source, null, null, variableValues)])
          })
        } else {
          it('should not support positional arguments', () => {
            const source = 'query MyQuery { hello(name: "world") }'
            const variableValues = { who: 'world' }

            return assert.rejects(() => graphql.graphql(schema, source, null, null, variableValues))
          })
        }

        // it('should not disable signature with invalid arguments', done => {
        //   agent
        //     .assertSomeTraces(traces => {
        //       const spans = sort(traces[0])

        //       console.log(spans.map(span => `${span.name} | ${span.resource}`))
        //       const resource = 'query WithFragments{human{...firstFields}}fragment firstFields on Human{name}'

        //       assert.strictEqual(spans[0].service, 'test')
        //       assert.strictEqual(spans[0].name, expectedSchema.server.opName)
        //       assert.strictEqual(spans[0].resource, resource)
        //       assert.ok(!('graphql.source' in spans[0].meta))
        //       assert.strictEqual(spans[0].meta['graphql.operation.type'], 'query')
        //       assert.strictEqual(spans[0].meta['graphql.operation.name'], 'WithFragments')
        //     })
        //     .then(done)
        //     .catch(done)

        //   const source = `{ human { address } }`

        //   const rootValue = {
        //     hello: () => 'world'
        //   }

        //   const contextValue = {}
        //   const document = graphql.parse(source)

        //   // graphql.graphql({ schema, source, rootValue, contextValue })
        //   //   .then(() => graphql.graphql({ schema, source, rootValue, contextValue }))
        //   //   .then(() => done())
        //   //   .catch(done)

        //   Promise.resolve(graphql.execute(schema, 'invalid', rootValue))
        //     .catch(() => graphql.execute(schema, document, rootValue))
        //     .catch(done)
        // })
      })

      describe('with configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', {
            service: 'custom',
            variables: variables => ({ ...variables, who: 'REDACTED' }),
            source: true,
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should be configured with the correct values', () => {
          const source = '{ hello(name: "world") }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assertObjectContains(spans[0], {
              service: 'custom',
              meta: {
                'graphql.source': '{ hello(name: "world") }',
                component: 'graphql',
              },
            })
            assertObjectContains(spans[1], {
              service: 'custom',
              meta: {
                'graphql.source': 'hello(name: "world")',
                component: 'graphql',
              },
            })
          }, { spanResourceMatch: /hello:String/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should apply the filter callback to the variables', () => {
          const source = `
            query MyQuery($title: String!, $who: String!) {
              hello(title: $title, name: $who)
            }
          `
          const variableValues = { title: 'planet', who: 'world' }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assertObjectContains(spans[0], {
              meta: {
                'graphql.variables.title': 'planet',
                'graphql.variables.who': 'REDACTED',
              },
            })
            assertObjectContains(spans[1], {
              meta: {
                'graphql.variables.title': 'planet',
                'graphql.variables.who': 'REDACTED',
              },
            })
          }, { spanResourceMatch: /MyQuery/ })

          return Promise.all([assertion, graphql.graphql({ schema, source, variableValues })])
        })
      })

      describe('with an array of variable names', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', {
            variables: ['title'],
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should only include the configured variables', () => {
          const source = `
            query MyQuery($title: String!, $who: String!) {
              hello(title: $title, name: $who)
            }
          `
          const variableValues = { title: 'planet', who: 'world' }

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans[0].meta['graphql.variables.title'], 'planet')
            assert.ok(!('graphql.variables.who' in spans[0].meta))
          })

          return Promise.all([assertion, graphql.graphql({ schema, source, variableValues })])
        })
      })

      describe('with configured error extensions', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { errorExtensions: ['code', 'extra'] })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('traces with the configured extensions resolved', () => {
          const source = '{ hello(name: "world") }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })
      })

      describe('with invalid configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { depth: 'all', variables: 5, errorExtensions: 'code' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('falls back to defaults and still traces', () => {
          const source = '{ hello(name: "world") }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })
      })

      describe('with a depth of 0', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { depth: 0 })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should only instrument the execution', () => {
          const source = `
            {
              human {
                name
                address {
                  civicNumber
                  street
                }
              }
            }
          `

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should run the resolvers in the execution scope', done => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = {
            hello () {
              const span = tracer.scope().active()

              try {
                assert.notStrictEqual(span, null)
                assert.ok('_name' in span.context())
                assert.strictEqual(span.context()._name, expectedSchema.server.opName)
                done()
              } catch (e) {
                done(e)
              }
            },
          }

          graphql.graphql({ schema, source, rootValue }).catch(done)
        })

        it('should publish resolver start for depth 0 AppSec subscribers', async () => {
          const startCh = dc.channel('datadog:graphql:resolver:start')
          const fields = []
          const handler = ({ resolverInfo }) => {
            fields.push(...Object.keys(resolverInfo || {}))
          }

          startCh.subscribe(handler)

          try {
            const source = '{ human { name } }'
            const result = await graphql.graphql({ schema, source })

            assert.ok(!result.errors || result.errors.length === 0, `Expected [${result.errors}] to be empty`)
            assert.deepStrictEqual(fields.sort(), ['human', 'name'])
          } finally {
            startCh.unsubscribe(handler)
          }
        })
      })

      describe('with a depth >=1', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { depth: 2 })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        const source = `
          {
            human {
              name
              address {
                civicNumber
                street
              }
            }
            friends {
              name
            }
          }
        `

        // friends.*.name sits two fields deep (friends -> name); the list index
        // between them is an execution artifact, not a query level, so depth: 2
        // reaches it. human.address.civicNumber / human.address.street sit three
        // fields deep and stay gated.
        const v6DepthTest = DD_MAJOR >= 6 ? it : it.skip
        v6DepthTest('counts selection-set depth only, so a collapsed list field resolves at its field depth', () => {
          const assertion = agent.assertSomeTraces(traces => {
            const paths = sort(traces[0])
              .filter(span => span.name === 'graphql.resolve')
              .map(span => span.meta['graphql.field.path'])
              .sort()

            assert.deepStrictEqual(paths, [
              'friends',
              'friends.*.name',
              'human',
              'human.address',
              'human.name',
            ])
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        // v5 counted the collapsed list index toward depth, so friends.*.name sat
        // three segments deep and was gated. Pin that contract on the v5 line.
        const legacyDepthTest = DD_MAJOR < 6 ? it : it.skip
        legacyDepthTest('counts collapsed list indices toward depth on v5', () => {
          const assertion = agent.assertSomeTraces(traces => {
            const paths = sort(traces[0])
              .filter(span => span.name === 'graphql.resolve')
              .map(span => span.meta['graphql.field.path'])
              .sort()

            assert.deepStrictEqual(paths, [
              'friends',
              'human',
              'human.address',
              'human.name',
            ])
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should honor resolver abort for fields gated by depth', async () => {
          let streetResolverRan = false
          const startCh = dc.channel('datadog:graphql:resolver:start')
          const handler = ({ abortController, resolverInfo }) => {
            if (resolverInfo?.street) abortController.abort()
          }

          const Address = new graphql.GraphQLObjectType({
            name: 'DepthAbortAddress',
            fields: {
              street: {
                type: graphql.GraphQLString,
                resolve () {
                  streetResolverRan = true
                  return 'foo street'
                },
              },
            },
          })
          const Human = new graphql.GraphQLObjectType({
            name: 'DepthAbortHuman',
            fields: {
              address: {
                type: Address,
                resolve: () => ({}),
              },
            },
          })
          const query = new graphql.GraphQLObjectType({
            name: 'DepthAbortQuery',
            fields: {
              human: {
                type: Human,
                resolve: () => ({}),
              },
            },
          })
          const localSchema = new graphql.GraphQLSchema({ query })

          startCh.subscribe(handler)

          try {
            const result = await graphql.graphql({
              schema: localSchema,
              source: '{ human { address { street } } }',
            })

            assert.strictEqual(streetResolverRan, false)
            assert.strictEqual(result.errors.length, 1)
            assert.strictEqual(result.errors[0].originalError?.name, 'AbortError')
          } finally {
            startCh.unsubscribe(handler)
          }
        })

        it('publishes apm:graphql:resolve:start for every resolver, including depth-gated ones', async () => {
          // The depth knob caps span creation, not channel publishes.
          // IAST taint-tracking and AppSec WAF subscribers run on every resolver
          // call so user-controlled args at any depth still flow through.
          const startCh = dc.channel('apm:graphql:resolve:start')
          const paths = []
          const handler = (ctx) => {
            paths.push(ctx.pathString)
          }
          startCh.subscribe(handler)

          try {
            const source = `
              {
                human {
                  name
                  address {
                    civicNumber
                    street
                  }
                }
              }
            `
            const [, result] = await Promise.all([
              agent.assertSomeTraces(traces => {
                const spans = sort(traces[0]).filter(span => span.name === 'graphql.resolve')
                const tracedPaths = spans.map(span => span.meta['graphql.field.path']).sort()
                assert.deepStrictEqual(tracedPaths, ['human', 'human.address', 'human.name'])
              }),
              graphql.graphql({ schema, source }),
            ])

            assert.ok(!result.errors || result.errors.length === 0, `Expected [${result.errors}] to be empty`)
            assert.deepStrictEqual(paths.sort(), [
              'human',
              'human.address',
              'human.address.civicNumber',
              'human.address.street',
              'human.name',
            ])
          } finally {
            startCh.unsubscribe(handler)
          }
        })

        it('should run depth-gated resolvers in the parent scope and still resolve the data', async () => {
          const localSchema = graphql.buildSchema(`
            type Query { outer: Outer }
            type Outer { middle: Middle }
            type Middle { inner: String }
          `)

          const captures = {}
          const captureActive = label => {
            captures[label] = tracer.scope().active()?.context()._name
          }

          const rootValue = {
            outer () {
              captureActive('outer')
              return {
                middle () {
                  captureActive('middle')
                  return {
                    inner () {
                      captureActive('inner')
                      return 'value'
                    },
                  }
                },
              }
            },
          }

          const result = await graphql.graphql({
            schema: localSchema,
            source: '{ outer { middle { inner } } }',
            rootValue,
          })

          assert.ok(!('errors' in result), `Unexpected per-field errors: ${JSON.stringify(result.errors)}`)
          assert.strictEqual(result.data?.outer?.middle?.inner, 'value')
          assert.deepStrictEqual(captures, {
            outer: 'graphql.resolve',
            middle: 'graphql.resolve',
            inner: expectedSchema.server.opName,
          })
        })
      })

      describe('with collapsing disabled', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { collapse: false })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should not collapse list field resolvers', () => {
          const source = '{ friends { name } }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 4)

            const execute = spans[0]
            const friends = spans[1]
            const friend0Name = spans[2]
            const friend1Name = spans[3]

            assert.strictEqual(execute.name, expectedSchema.server.opName)

            assertObjectContains(friends, {
              name: 'graphql.resolve',
              resource: 'friends:[Human]',
              meta: {
                'graphql.field.path': 'friends',
              },
            })
            assert.strictEqual(friends.parent_id.toString(), execute.span_id.toString())

            assertObjectContains(friend0Name, {
              name: 'graphql.resolve',
              resource: 'name:String',
              meta: {
                'graphql.field.path': 'friends.0.name',
              },
            })
            assert.strictEqual(friend0Name.parent_id.toString(), friends.span_id.toString())

            assertObjectContains(friend1Name, {
              name: 'graphql.resolve',
              resource: 'name:String',
              meta: {
                'graphql.field.path': 'friends.1.name',
              },
            })
            assert.strictEqual(friend1Name.parent_id.toString(), friends.span_id.toString())
          }, { spanResourceMatch: /friends:\[Human]/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should trace aliased __proto__ fields when collapsing is disabled', async () => {
          const source = '{ __proto__: hello(name: "alias") }'

          const [, result] = await Promise.all([
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])
              const resolveSpans = spans.filter(span => span.name === 'graphql.resolve')

              assert.strictEqual(resolveSpans.length, 1)
              assertObjectContains(resolveSpans[0], {
                resource: 'hello:String',
                error: 0,
                meta: {
                  'graphql.field.path': '__proto__',
                },
              })
            }, { spanResourceMatch: /hello:String/ }),
            graphql.graphql({ schema, source }),
          ])

          assert.ok(
            !result.errors || result.errors.length === 0,
            `Got errors: ${inspect(result.errors)}`
          )
          // eslint-disable-next-line no-proto
          assert.strictEqual(result.data.__proto__, 'alias')
        })
      })

      describe('with collapsing disabled and a depth >=1', () => {
        before(async () => {
          tracer = await agent.load('graphql', { collapse: false, depth: 2 })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should count only string segments when collapsing is disabled', () => {
          const source = `
            {
              friends {
                name
                pets {
                  name
                }
              }
            }
          `

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])
            const resolveSpans = spans.filter(span => span.name === 'graphql.resolve')
            const paths = resolveSpans.map(span => span.meta['graphql.field.path']).sort()

            assert.deepStrictEqual(paths, [
              'friends',
              'friends.0.name',
              'friends.0.pets',
              'friends.1.name',
              'friends.1.pets',
            ])
          })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })
      })

      describe('with signature calculation disabled', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { signature: false })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should fallback to the operation type and name', () => {
          const source = 'query WithoutSignature { friends { name } }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assertObjectContains(spans[0], {
              name: expectedSchema.server.opName,
              resource: 'query WithoutSignature',
            })
          }, { spanResourceMatch: /WithoutSignature/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should fallback to the operation type', async () => {
          const source = '{ friends { name } }'

          await Promise.all([
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[0].resource, 'query')
            }),
            graphql.graphql({ schema, source }),
          ])
        })
      })

      describe('with hooks configuration', () => {
        const config = {
          hooks: {
            execute: sinon.spy((span, context, res) => {}),
            parse: sinon.spy((span, document, operation) => {}),
            validate: sinon.spy((span, document, error) => {}),
            resolve: sinon.spy((span, field) => {}),
          },
        }

        const source = `
            fragment queryFields on Query {
              hello(name: "world")
            }
            query MyQuery { ...queryFields }
          `

        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', config)
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        afterEach(() => Object.keys(config.hooks).forEach(
          key => config.hooks[key].resetHistory()
        ))

        after(() => agent.close())

        it('should run the execute hook before graphql.execute span is finished', () => {
          const document = graphql.parse(source)

          graphql.validate(schema, document)

          const params = {
            schema,
            document,
            rootValue: {
              hello: () => 'world',
            },
            contextValue: {},
            variableValues: { who: 'world' },
            operationName: 'MyQuery',
            fieldResolver: (source, args, contextValue, info) => args.name,
            typeResolver: (value, context, info, abstractType) => 'Query',
          }

          let result

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].name, expectedSchema.server.opName)
            sinon.assert.calledOnce(config.hooks.execute)

            const span = config.hooks.execute.firstCall.args[0]
            const args = config.hooks.execute.firstCall.args[1]
            const res = config.hooks.execute.firstCall.args[2]

            assert.strictEqual(span.context()._name, expectedSchema.server.opName)

            // These two properties are circular structures.
            assert.deepStrictEqual(args.document, params.document)
            assert.deepStrictEqual(args.schema, params.schema)

            // The helper can not handle circular structures properly.
            assertObjectContains(args, {
              rootValue: params.rootValue,
              contextValue: params.contextValue,
              variableValues: params.variableValues,
              operationName: params.operationName,
              typeResolver: params.typeResolver,
            })
            assert.strictEqual(typeof args.fieldResolver, 'function')
            assert.notStrictEqual(args.fieldResolver, params.fieldResolver)
            assert.strictEqual(res, result)
          }, { spanResourceMatch: /MyQuery/ })

          const action = Promise.resolve(graphql.execute(params))
            .then(res => {
              result = res
            })

          return Promise.all([assertion, action])
        })

        it('should run the validate hook before graphql.validate span is finished', () => {
          const document = graphql.parse(source)

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].name, 'graphql.validate')
            sinon.assert.calledOnce(config.hooks.validate)

            const span = config.hooks.validate.firstCall.args[0]
            const hookDocument = config.hooks.validate.firstCall.args[1]
            const hookErrors = config.hooks.validate.firstCall.args[2]

            assert.strictEqual(span.context()._name, 'graphql.validate')

            assert.strictEqual(hookDocument, document)
            assert.strictEqual(hookErrors, errors)
          })

          const errors = graphql.validate(schema, document)

          return assertion
        })

        it('should run the parse hook before graphql.parse span is finished', () => {
          let document

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 1)
            assert.strictEqual(spans[0].name, 'graphql.parse')
            sinon.assert.calledOnce(config.hooks.parse)

            const span = config.hooks.parse.firstCall.args[0]
            const hookSource = config.hooks.parse.firstCall.args[1]
            const hookDocument = config.hooks.parse.firstCall.args[2]

            assert.strictEqual(span.context()._name, 'graphql.parse')

            assert.strictEqual(hookSource, source)
            assert.strictEqual(hookDocument, document)
          })

          const action = Promise.resolve(graphql.parse(source))
            .then(res => {
              document = res
            })

          return Promise.all([assertion, action])
        })

        it('should run the resolve hook before graphql.resolve span is finished', () => {
          const resolveSource = '{ hello(name: "world") }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            assert.strictEqual(spans.length, 2)
            assert.strictEqual(spans[1].name, 'graphql.resolve')
            sinon.assert.calledOnce(config.hooks.resolve)

            const span = config.hooks.resolve.firstCall.args[0]
            const field = config.hooks.resolve.firstCall.args[1]

            assert.strictEqual(span.context()._name, 'graphql.resolve')
            assert.strictEqual(field.fieldName, 'hello')
            assert.strictEqual(field.path, 'hello')
            assert.strictEqual(field.error, null)
            assert.strictEqual(field.result, 'world')
          }, { spanResourceMatch: /hello:String/ })

          return Promise.all([
            assertion,
            graphql.graphql({ schema, source: resolveSource }),
          ])
        })
      })

      withVersions('graphql', 'apollo-server-core', apolloVersion => {
        // The precense of graphql@^15.2.0 in the /versions folder causes graphql-tools@3.1.1
        // to break in the before() hook. This test tests a library version that had its release occur 5 years ago
        // updating the test would require using newer version of apollo-core which have a completely different syntax
        // library name, and produce traces that are different then what is expected by this test
        // TODO: this is an outdated test, comeback to it by officially adding support for the newer versions of
        // apollo server
        describe.skip('apollo-server-core', () => {
          let runQuery
          let mergeSchemas
          let makeExecutableSchema

          before(() => {
            tracer = require('../../dd-trace')

            return agent.load('graphql')
              .then(() => {
                graphql = require(`../../../versions/graphql@${version}`).get()

                const apolloCore = require(`../../../versions/apollo-server-core@${apolloVersion}`).get()
                const graphqlTools = require('../../../versions/graphql-tools@3.1.1').get()

                runQuery = apolloCore.runQuery
                mergeSchemas = graphqlTools.mergeSchemas
                makeExecutableSchema = graphqlTools.makeExecutableSchema
              })
          })

          after(() => {
            return agent.close()
          })

          it('should support apollo-server schema stitching', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans.length, 3)

                assert.strictEqual(spans[0].name, expectedSchema.server.opName)
                assert.strictEqual(spans[0].resource, 'query MyQuery{hello}')
                assert.ok(!('graphql.source' in spans[0].meta))

                assert.strictEqual(spans[1].name, 'graphql.resolve')
                assert.strictEqual(spans[1].resource, 'hello:String')

                assert.strictEqual(spans[2].name, 'graphql.validate')
                assert.ok(!('graphql.source' in spans[2].meta))
              })
              .then(done)
              .catch(done)

            schema = mergeSchemas({
              schemas: [
                makeExecutableSchema({
                  typeDefs: `
                type Query {
                  hello: String
                }
              `,
                  resolvers: {
                    Query: {
                      hello: () => 'Hello world!',
                    },
                  },
                }),
                makeExecutableSchema({
                  typeDefs: `
                type Query {
                  world: String
                }
              `,
                  resolvers: {
                    Query: {
                      world: () => 'Hello world!',
                    },
                  },
                }),
              ],
            })

            const params = {
              schema,
              query: 'query MyQuery { hello }',
              operationName: 'MyQuery',
            }

            runQuery(params)
              .catch(done)
          })
        })
      })

      // Apollo Federation exposes entity types only through the synthetic
      // `_Entity` union returned by `Query._entities`, and abstract types through
      // interfaces. graphql resolves the concrete type at runtime, so the
      // schema-traversal that wraps resolvers must descend into union members and
      // interface implementations or those resolvers never get a graphql.resolve
      // span. The schemas are built by hand with the same versioned graphql the
      // suite instruments (a separate instance would emit no spans). Regression
      // for https://github.com/DataDog/dd-trace-js/issues/1057.
      describe('federation / abstract types', () => {
        // Apollo Federation (and the abstract-type schema shapes it relies on)
        // targets modern graphql; the pre-1.0 majors still in the matrix predate
        // the schema APIs these fixtures use, so scope the suite to 15+.
        const supported = semver.satisfies(graphqlVersion, '>=15.0.0')

        before(async function () {
          if (!supported) return this.skip()

          tracer = await agent.load('graphql')
        })

        beforeEach(function () {
          if (!supported) return this.skip()
          graphql = require(`../../../versions/graphql@${version}`).get()
        })

        after(() => agent.close())

        it('should create graphql.resolve spans for fields reached only through a union member', () => {
          // Product is reachable only as a union member (no field returns it
          // directly), mirroring federation's `_Entity` union. Without descending
          // into union members the current traversal never wraps Product.name.
          const Product = new graphql.GraphQLObjectType({
            name: 'Product',
            fields: {
              name: { type: graphql.GraphQLString, resolve: () => 'Table' },
            },
          })

          const Entity = new graphql.GraphQLUnionType({
            name: '_Entity',
            types: [Product],
            resolveType: () => 'Product',
          })

          const schema = new graphql.GraphQLSchema({
            query: new graphql.GraphQLObjectType({
              name: 'Query',
              fields: {
                entity: { type: Entity, resolve: () => ({}) },
              },
            }),
          })

          const source = 'query { entity { ... on Product { name } } }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            const productName = spans.find(span =>
              span.name === 'graphql.resolve' && span.meta['graphql.field.name'] === 'name')
            assert.ok(productName, 'graphql.resolve span for the field reached via the union should be emitted')
            assert.strictEqual(productName.meta['graphql.field.type'], 'String')
          }, { spanResourceMatch: /name:String/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should create graphql.resolve spans for fields reached only through an interface', () => {
          const Node = new graphql.GraphQLInterfaceType({
            name: 'Node',
            fields: {
              id: { type: new graphql.GraphQLNonNull(graphql.GraphQLID) },
            },
            resolveType: () => 'Widget',
          })

          // Widget.label is reachable only as an interface implementation, and
          // Widget.next loops back to the Node interface — the recursive-interface
          // shape that must terminate the per-schema descent instead of recursing.
          const Widget = new graphql.GraphQLObjectType({
            name: 'Widget',
            interfaces: [Node],
            fields: {
              id: { type: new graphql.GraphQLNonNull(graphql.GraphQLID), resolve: () => '1' },
              label: { type: graphql.GraphQLString, resolve: () => 'a widget' },
              next: { type: Node, resolve: () => undefined },
            },
          })

          const schema = new graphql.GraphQLSchema({
            query: new graphql.GraphQLObjectType({
              name: 'Query',
              fields: {
                node: { type: Node, resolve: () => ({}) },
              },
            }),
            // Widget implements Node but is referenced by no field, so it reaches
            // the type map only through this explicit registration — the shape a
            // federated interface implementation has.
            types: [Widget],
          })

          const source = 'query { node { id ... on Widget { label next { id } } } }'

          const assertion = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            const label = spans.find(span =>
              span.name === 'graphql.resolve' && span.meta['graphql.field.name'] === 'label')
            assert.ok(label, 'graphql.resolve span for the interface implementation field should be emitted')
            assert.strictEqual(label.meta['graphql.field.type'], 'String')
          }, { spanResourceMatch: /label:String/ })

          return Promise.all([assertion, graphql.graphql({ schema, source })])
        })

        it('should skip the execute span for the federation health-check operation', async () => {
          const schema = new graphql.GraphQLSchema({
            query: new graphql.GraphQLObjectType({
              name: 'Query',
              fields: {
                hello: { type: graphql.GraphQLString, resolve: () => 'world' },
              },
            }),
          })

          // bindStart publishes apm:graphql:execute:start only after it commits to
          // tracing the operation, so a 0 count proves the health-check was skipped
          // before span creation. The normal operation below proves the counter fires.
          const executeCh = dc.channel('apm:graphql:execute:start')
          let starts = 0
          const handler = () => { starts++ }
          executeCh.subscribe(handler)

          try {
            // The exact operation Apollo Gateway polls subgraphs with.
            const source = 'query __ApolloServiceHealthCheck__ { __typename }'
            const healthCheck = await graphql.graphql({ schema, source })
            assert.ok(!healthCheck.errors, inspect(healthCheck.errors))
            assert.strictEqual(starts, 0, 'execute span must be skipped for the health-check operation')

            const normal = await graphql.graphql({ schema, source: 'query { hello }' })
            assert.ok(!normal.errors, inspect(normal.errors))
            assert.strictEqual(starts, 1, 'a normal operation must still be traced')
          } finally {
            executeCh.unsubscribe(handler)
          }
        })

        // Operation names are client-controlled: only the gateway's exact
        // `query __ApolloServiceHealthCheck__ { __typename }` shape is skipped.
        // Every request that reuses the reserved name but diverges from that
        // shape must still be traced (and its resolvers must still reach the
        // AppSec/IAST channels), so the skip can't become a tracing/security
        // bypass. Each source diverges on a single dimension the shape check reads.
        const spoofedHealthChecks = {
          'a real field instead of __typename': 'query __ApolloServiceHealthCheck__ { hello }',
          'an extra selection alongside __typename': 'query __ApolloServiceHealthCheck__ { __typename hello }',
          'the mutation operation type': 'mutation __ApolloServiceHealthCheck__ { hello }',
        }

        for (const [divergence, source] of Object.entries(spoofedHealthChecks)) {
          it(`should trace an operation that spoofs the health-check name with ${divergence}`, async () => {
            const helloField = { type: graphql.GraphQLString, resolve: () => 'world' }
            const schema = new graphql.GraphQLSchema({
              query: new graphql.GraphQLObjectType({ name: 'Query', fields: { hello: helloField } }),
              mutation: new graphql.GraphQLObjectType({ name: 'Mutation', fields: { hello: helloField } }),
            })

            const executeCh = dc.channel('apm:graphql:execute:start')
            let starts = 0
            const handler = () => { starts++ }
            executeCh.subscribe(handler)

            try {
              const spoofed = await graphql.graphql({ schema, source })
              assert.ok(!spoofed.errors, inspect(spoofed.errors))
              assert.strictEqual(starts, 1, 'an operation spoofing the health-check name must still be traced')
            } finally {
              executeCh.unsubscribe(handler)
            }
          })
        }

        it('should not let a shared interface hide a second schema\'s implementation fields', async () => {
          // One Node interface instance, reused across two schemas that each
          // register a different implementation. resolveType picks the concrete
          // type off __typename, which the root resolver stamps on the value.
          const Node = new graphql.GraphQLInterfaceType({
            name: 'Node',
            fields: {
              id: { type: new graphql.GraphQLNonNull(graphql.GraphQLID) },
            },
            resolveType: value => value.__typename,
          })

          // Each impl exposes a distinctly-named field so the graphql.resolve
          // resource identifies which schema's implementation was wrapped —
          // `widgetLabel:String` vs `gadgetLabel:String`. A shared `label` would
          // let the first schema's span satisfy the second schema's assertion.
          const makeImpl = name => new graphql.GraphQLObjectType({
            name,
            interfaces: [Node],
            fields: {
              id: { type: new graphql.GraphQLNonNull(graphql.GraphQLID), resolve: () => '1' },
              [`${name.toLowerCase()}Label`]: { type: graphql.GraphQLString, resolve: () => `a ${name}` },
            },
          })

          const makeSchema = impl => new graphql.GraphQLSchema({
            query: new graphql.GraphQLObjectType({
              name: 'Query',
              fields: {
                node: { type: Node, resolve: () => ({ __typename: impl.name }) },
              },
            }),
            // Impl reaches the type map only through this explicit registration —
            // the shape a federated interface implementation has.
            types: [impl],
          })

          const firstSchema = makeSchema(makeImpl('Widget'))
          const secondSchema = makeSchema(makeImpl('Gadget'))

          // Walk the first schema so the shared Node interface is recorded; a
          // global one-time guard would then stop the second schema's walk before
          // it reaches Gadget, leaving gadgetLabel unwrapped. getPossibleTypes is
          // schema-specific, so the interface descent must run per schema.
          await graphql.graphql({
            schema: firstSchema,
            source: 'query { node { id ... on Widget { widgetLabel } } }',
          })

          const assertion = agent.assertSomeTraces(traces => {
            const label = sort(traces[0]).find(span =>
              span.name === 'graphql.resolve' && span.meta['graphql.field.name'] === 'gadgetLabel')
            assert.ok(label, 'the second schema\'s interface implementation field should be wrapped')
            assert.strictEqual(label.meta['graphql.field.type'], 'String')
          }, { spanResourceMatch: /gadgetLabel:String/ })

          await Promise.all([
            assertion,
            graphql.graphql({
              schema: secondSchema,
              source: 'query { node { id ... on Gadget { gadgetLabel } } }',
            }),
          ])
        })

        it('should wrap a second schema\'s implementations when both reuse the same parent type', async () => {
          const Node = new graphql.GraphQLInterfaceType({
            name: 'Node',
            fields: {
              id: { type: new graphql.GraphQLNonNull(graphql.GraphQLID) },
            },
          })

          const makeImpl = name => new graphql.GraphQLObjectType({
            name,
            interfaces: [Node],
            isTypeOf: () => true,
            fields: {
              id: { type: new graphql.GraphQLNonNull(graphql.GraphQLID), resolve: () => '1' },
              [`${name.toLowerCase()}Label`]: { type: graphql.GraphQLString, resolve: () => `a ${name}` },
            },
          })

          // The same Query instance in both schemas is the shared parent that a
          // global walk-guard marks on the first schema, stopping the second
          // schema's walk before it reaches the `node` field's interface.
          const Query = new graphql.GraphQLObjectType({
            name: 'Query',
            fields: {
              node: { type: Node, resolve: () => ({}) },
            },
          })

          const firstSchema = new graphql.GraphQLSchema({ query: Query, types: [makeImpl('Widget')] })
          const secondSchema = new graphql.GraphQLSchema({ query: Query, types: [makeImpl('Gadget')] })

          await graphql.graphql({
            schema: firstSchema,
            source: 'query { node { id ... on Widget { widgetLabel } } }',
          })

          const assertion = agent.assertSomeTraces(traces => {
            const label = sort(traces[0]).find(span =>
              span.name === 'graphql.resolve' && span.meta['graphql.field.name'] === 'gadgetLabel')
            assert.ok(label, 'the second schema\'s interface implementation field should be wrapped')
            assert.strictEqual(label.meta['graphql.field.type'], 'String')
          }, { spanResourceMatch: /gadgetLabel:String/ })

          await Promise.all([
            assertion,
            graphql.graphql({
              schema: secondSchema,
              source: 'query { node { id ... on Gadget { gadgetLabel } } }',
            }),
          ])
        })
      })
    })
  })
})
