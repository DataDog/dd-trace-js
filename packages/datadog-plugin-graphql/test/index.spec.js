'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { performance } = require('perf_hooks')

const axios = require('axios')
const { expect } = require('chai')
const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const plugin = require('../src')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const { assertObjectContains } = require('../../../integration-tests/helpers')

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
          }
        },
        address: {
          type: new graphql.GraphQLObjectType({
            name: 'Address',
            fields: {
              civicNumber: {
                type: graphql.GraphQLString,
                resolve: () => 123
              },
              street: {
                type: graphql.GraphQLString,
                resolve: () => 'foo street'
              }
            }
          }),
          resolve (obj, args) {
            return {}
          }
        },
        pets: {
          type: new graphql.GraphQLList(new graphql.GraphQLNonNull(new graphql.GraphQLObjectType({
            name: 'Pet',
            fields: () => ({
              type: {
                type: graphql.GraphQLString,
                resolve: () => 'dog'
              },
              name: {
                type: graphql.GraphQLString,
                resolve: () => 'foo bar'
              },
              owner: {
                type: Human,
                resolve: () => ({})
              },
              colours: {
                type: new graphql.GraphQLList(new graphql.GraphQLObjectType({
                  name: 'Colour',
                  fields: {
                    code: {
                      type: graphql.GraphQLString,
                      resolve: () => '#ffffff'
                    }
                  }
                })),
                resolve (obj, args) {
                  return [{}, {}]
                }
              }
            })
          }))),
          resolve (obj, args) {
            return [{}, {}, {}]
          }
        },
        fastAsyncField: {
          type: graphql.GraphQLString,
          resolve (obj, args) {
            return new Promise((resolve) => {
              markFast = performance.now()
              resolve('fast field')
            })
          }
        },
        slowAsyncField: {
          type: graphql.GraphQLString,
          resolve (obj, args) {
            return new Promise((resolve) => {
              markSlow = performance.now()
              resolve('slow field')
            })
          }
        },
        syncField: {
          type: graphql.GraphQLString,
          resolve (obj, args) {
            markSync = performance.now()
            return 'sync field'
          }
        },
        oneTime: {
          type: graphql.GraphQLString,
          resolve: () => new Query('one-time result')
        }
      }
    })

    schema = new graphql.GraphQLSchema({
      query: new graphql.GraphQLObjectType({
        name: 'RootQueryType',
        fields: {
          hello: {
            type: graphql.GraphQLString,
            args: {
              name: {
                type: graphql.GraphQLString
              },
              title: {
                type: graphql.GraphQLString,
                defaultValue: null
              }
            },
            resolve (obj, args) {
              return args.name
            }
          },
          human: {
            type: Human,
            resolve (obj, args) {
              return Promise.resolve({})
            }
          },
          friends: {
            type: new graphql.GraphQLList(Human),
            resolve () {
              return [{ name: 'alice' }, { name: 'bob' }]
            }
          }
        }
      }),

      mutation: new graphql.GraphQLObjectType({
        name: 'RootMutationType',
        fields: {
          human: {
            type: Human,
            resolve () {
              return Promise.resolve({ name: 'human name' })
            }
          }
        }
      }),

      subscription: new graphql.GraphQLObjectType({
        name: 'RootSubscriptionType',
        fields: {
          human: {
            type: Human,
            resolve () {
              return Promise.resolve({ name: 'human name' })
            }
          }
        }
      })
    })
  }

  describe('graphql', () => {
    withVersions('graphql', 'graphql', version => {
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
            'graphql.resolve'
          ]

          if (a.start.toString() === b.start.toString()) {
            return order.indexOf(a.name) - order.indexOf(b.name)
          }

          return a.start.toString() >= b.start.toString() ? 1 : -1
        })
      })

      describe('graphql-yoga', () => {
        withVersions(plugin, 'graphql-yoga', version => {
          let graphqlYoga
          let server
          let port

          before(() => {
            tracer = require('../../dd-trace')
            return agent.load('graphql')
              .then(() => {
                graphqlYoga = require(`../../../versions/graphql-yoga@${version}`).get()

                const typeDefs = `
                  type Query {
                    hello(name: String): String
                  }
                `

                const resolvers = {
                  Query: {
                    hello: (_, { name }) => {
                      return `Hello, ${name || 'world'}!`
                    }
                  }
                }

                const schema = graphqlYoga.createSchema({
                  typeDefs, resolvers
                })

                const yoga = graphqlYoga.createYoga({ schema })

                server = http.createServer(yoga)
              })
          })

          before(done => {
            server.listen(0, () => {
              port = server.address().port
              done()
            })
          })

          after(() => {
            server.close()
            return agent.close({ ritmReset: false })
          })

          it('should instrument graphql-yoga execution', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].service, expectedSchema.server.serviceName)
                assert.strictEqual(spans[0].name, expectedSchema.server.opName)
                assert.strictEqual(spans[0].resource, 'query MyQuery{hello(name:"")}')
                assert.strictEqual(spans[0].type, 'graphql')
                assert.strictEqual(spans[0].error, 0)
                assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
                assert.strictEqual(spans[0].meta['graphql.operation.type'], 'query')
                assert.strictEqual(spans[0].meta['graphql.operation.name'], 'MyQuery')
                assert.strictEqual(spans[0].meta.component, 'graphql')
                assert.strictEqual(spans[0].meta['_dd.integration'], 'graphql')
              })
              .then(done)

            const query = `
              query MyQuery {
                hello(name: "world")
              }
            `

            axios.post(`http://localhost:${port}/graphql`, {
              query
            }).catch(done)
          })
        })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('graphql')
            .then(() => {
              tracer = require('../../dd-trace')
              graphql = require(`../../../versions/graphql@${version}`).get()
              buildSchema()
            })
        })

        after(() => {
          return agent.close({ ritmReset: false })
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
            }
          }
        )

        it('should instrument parsing', done => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }

          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.name, 'graphql.parse')
              assert.strictEqual(span.resource, 'graphql.parse')
              assert.strictEqual(span.type, 'graphql')
              assert.strictEqual(span.error, 0)
              assert.ok(!Object.hasOwn(span.meta, 'graphql.source'))
              assert.strictEqual(span.meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should instrument validation', done => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }

          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(span.service, 'test')
              assert.strictEqual(span.name, 'graphql.validate')
              assert.strictEqual(span.resource, 'graphql.validate')
              assert.strictEqual(span.type, 'graphql')
              assert.strictEqual(span.error, 0)
              assert.ok(!Object.hasOwn(span.meta, 'graphql.source'))
              assert.strictEqual(span.meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should instrument execution', done => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].service, expectedSchema.server.serviceName)
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[0].resource, 'query MyQuery{hello(name:"")}')
              assert.strictEqual(spans[0].type, 'graphql')
              assert.strictEqual(spans[0].error, 0)
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
              assert.strictEqual(spans[0].meta['graphql.operation.type'], 'query')
              assert.strictEqual(spans[0].meta['graphql.operation.name'], 'MyQuery')
              assert.strictEqual(spans[0].meta.component, 'graphql')
            })
            .then(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should not include variables by default', done => {
          const source = 'query MyQuery($who: String!) { hello(name: $who) }'
          const variableValues = { who: 'world' }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.variables'))
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should instrument schema resolvers', done => {
          const source = '{ hello(name: "world") }'

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
              assert.strictEqual(spans[1].service, 'test')
              assert.strictEqual(spans[1].name, 'graphql.resolve')
              assert.strictEqual(spans[1].resource, 'hello:String')
              assert.strictEqual(spans[1].type, 'graphql')
              assert.strictEqual(spans[1].error, 0)
              assert.ok(Number(spans[1].duration) > 0)
              assert.strictEqual(spans[1].meta['graphql.field.name'], 'hello')
              assert.strictEqual(spans[1].meta['graphql.field.path'], 'hello')
              assert.strictEqual(spans[1].meta['graphql.field.type'], 'String')
              assert.ok(!Object.hasOwn(spans[1].meta, 'graphql.source'))
              assert.strictEqual(spans[1].meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
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
                    assert.ok(fastAsyncTime < slowAsyncTime)
                    foundFastFieldSpan = true
                  } else if (span.resource === 'slowAsyncField:String') {
                    assert.ok(slowAsyncTime < syncTime)
                    foundSlowFieldSpan = true
                  } else if (span.resource === 'syncField:String') {
                    assert.ok(syncTime > slowAsyncTime)
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

        it('should instrument nested field resolvers', done => {
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

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])
              assert.strictEqual(spans.length, 6)

              const execute = spans[0]
              const human = spans[1]
              const humanName = spans[2]
              const address = spans[3]
              const addressCivicNumber = spans[4]
              const addressStreet = spans[5]

              assert.strictEqual(execute.name, expectedSchema.server.opName)
              assert.strictEqual(execute.error, 0)

              assert.strictEqual(human.name, 'graphql.resolve')
              assert.strictEqual(human.resource, 'human:Human')
              assert.strictEqual(human.error, 0)
              assert.strictEqual(human.meta['graphql.field.path'], 'human')
              assert.strictEqual(human.parent_id.toString(), execute.span_id.toString())

              assert.strictEqual(humanName.name, 'graphql.resolve')
              assert.strictEqual(humanName.resource, 'name:String')
              assert.strictEqual(humanName.error, 0)
              assert.strictEqual(humanName.meta['graphql.field.path'], 'human.name')
              assert.strictEqual(humanName.parent_id.toString(), human.span_id.toString())

              assert.strictEqual(address.name, 'graphql.resolve')
              assert.strictEqual(address.resource, 'address:Address')
              assert.strictEqual(address.error, 0)
              assert.strictEqual(address.meta['graphql.field.path'], 'human.address')
              assert.strictEqual(address.parent_id.toString(), human.span_id.toString())

              assert.strictEqual(addressCivicNumber.name, 'graphql.resolve')
              assert.strictEqual(addressCivicNumber.resource, 'civicNumber:String')
              assert.strictEqual(addressCivicNumber.error, 0)
              assert.strictEqual(addressCivicNumber.meta['graphql.field.path'], 'human.address.civicNumber')
              assert.strictEqual(addressCivicNumber.parent_id.toString(), address.span_id.toString())

              assert.strictEqual(addressStreet.name, 'graphql.resolve')
              assert.strictEqual(addressStreet.resource, 'street:String')
              assert.strictEqual(addressStreet.error, 0)
              assert.strictEqual(addressStreet.meta['graphql.field.path'], 'human.address.street')
              assert.strictEqual(addressStreet.parent_id.toString(), address.span_id.toString())
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should instrument list field resolvers', done => {
          const source = `{
            friends {
              name
              pets {
                name
              }
            }
          }`

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 5)

              const execute = spans[0]
              const friends = spans[1]
              const friendsName = spans[2]
              const pets = spans[3]
              const petsName = spans[4]

              assert.strictEqual(execute.name, expectedSchema.server.opName)

              assert.strictEqual(friends.name, 'graphql.resolve')
              assert.strictEqual(friends.resource, 'friends:[Human]')
              assert.strictEqual(friends.meta['graphql.field.path'], 'friends')
              assert.strictEqual(friends.parent_id.toString(), execute.span_id.toString())

              assert.strictEqual(friendsName.name, 'graphql.resolve')
              assert.strictEqual(friendsName.resource, 'name:String')
              assert.strictEqual(friendsName.meta['graphql.field.path'], 'friends.*.name')
              assert.strictEqual(friendsName.parent_id.toString(), friends.span_id.toString())

              assert.strictEqual(pets.name, 'graphql.resolve')
              assert.strictEqual(pets.resource, 'pets:[Pet!]')
              assert.strictEqual(pets.meta['graphql.field.path'], 'friends.*.pets')
              assert.strictEqual(pets.parent_id.toString(), friends.span_id.toString())

              assert.strictEqual(petsName.name, 'graphql.resolve')
              assert.strictEqual(petsName.resource, 'name:String')
              assert.strictEqual(petsName.meta['graphql.field.path'], 'friends.*.pets.*.name')
              assert.strictEqual(petsName.parent_id.toString(), pets.span_id.toString())
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should instrument mutations', done => {
          const source = 'mutation { human { name } }'

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].meta['graphql.operation.type'], 'mutation')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should instrument subscriptions', done => {
          const source = 'subscription { human { name } }'

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].meta['graphql.operation.type'], 'subscription')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should handle a circular schema', done => {
          const source = '{ human { pets { owner { name } } } }'

          graphql.graphql({ schema, source })
            .then((result) => {
              assert.strictEqual(result.data.human.pets[0].owner.name, 'test')
            })
            .then(done)
            .catch(done)
        })

        it('should instrument the default field resolver', done => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'
          const rootValue = { hello: 'world' }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[1].name, 'graphql.resolve')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, rootValue }).catch(done)
        })

        it('should instrument the execution field resolver without a rootValue resolver', done => {
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

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[1].name, 'graphql.resolve')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, rootValue, fieldResolver }).catch(done)
        })

        it('should not instrument schema resolvers multiple times', done => {
          const source = '{ hello(name: "world") }'

          agent.assertSomeTraces(() => { // skip first call
            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans.length, 2)
              })
              .then(done)
              .catch(done)

            graphql.graphql({ schema, source }).catch(done)
          })

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should run parsing, validation and execution in the current context', done => {
          const source = 'query MyQuery { hello(name: "world") }'
          const variableValues = { who: 'world' }
          const span = tracer.startSpan('test.request')

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 5)

              assert.strictEqual(spans[0].name, 'test.request')

              assert.strictEqual(spans[1].service, 'test')
              assert.strictEqual(spans[1].name, 'graphql.parse')

              assert.strictEqual(spans[2].service, 'test')
              assert.strictEqual(spans[2].name, 'graphql.validate')

              assert.strictEqual(spans[3].service, expectedSchema.server.serviceName)
              assert.strictEqual(spans[3].name, expectedSchema.server.opName)
              assert.strictEqual(spans[3].resource, 'query MyQuery{hello(name:"")}')

              assert.strictEqual(spans[4].service, 'test')
              assert.strictEqual(spans[4].name, 'graphql.resolve')
              assert.strictEqual(spans[4].resource, 'hello:String')
            })
            .then(done)
            .catch(done)

          tracer.scope().activate(span, () => {
            graphql.graphql({ schema, source, variableValues })
              .then(() => span.finish())
              .catch(done)
          })
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
            }
          }

          graphql.graphql({ schema, source, rootValue }).catch(done)
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
            }
          }

          const span = tracer.startSpan('test')

          return tracer.scope().activate(span, () => {
            return graphql.graphql({ schema, source, rootValue })
              .then(value => {
                expect(value).to.have.nested.property('data.hello', 'test')
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
              assert.ok(!Object.hasOwn(result, 'errors'))
            })
        })

        it('should handle calling low level APIs directly', done => {
          const source = 'query MyQuery { hello(name: "world") }'

          Promise
            .all([
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
              })
            ])
            .then(() => done())
            .catch(done)

          // These are the 3 lower-level steps
          const document = graphql.parse(source)
          graphql.validate(schema, document)
          graphql.execute({ schema, document })
        })

        it('should not re-execute thenables from resolvers', async () => {
          const source = '{ human { oneTime } }'

          const result = await graphql.graphql({ schema, source })
          assert.ok(!Object.hasOwn(result, 'errors'))
          assert.strictEqual(result.data.human.oneTime, 'one-time result')
        })

        it('should handle Source objects', done => {
          const source = 'query MyQuery { hello(name: "world") }'
          const document = graphql.parse(new graphql.Source(source))

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
              assert.strictEqual(spans[0].service, expectedSchema.server.serviceName)
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[0].resource, 'query MyQuery{hello(name:"")}')
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
              assert.strictEqual(spans[0].meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.execute({ schema, document })
        })

        it('should handle parsing exceptions', done => {
          let error

          agent
            .assertSomeTraces(traces => {
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
            .then(done)
            .catch(done)

          try {
            graphql.parse('invalid')
          } catch (e) {
            error = e
          }
        })

        it('should handle validation exceptions', done => {
          let error

          agent
            .assertSomeTraces(traces => {
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
            .then(done)
            .catch(done)

          try {
            graphql.validate()
          } catch (e) {
            error = e
          }
        })

        it('should handle validation errors', done => {
          const source = '{ human { address } }'
          const document = graphql.parse(source)

          agent
            .assertSomeTraces(traces => {
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
              assert.ok(Object.hasOwn(spanEvents[0], 'startTime'))
              assert.strictEqual(spanEvents[0].name, 'dd.graphql.query.error')
              assert.strictEqual(spanEvents[0].attributes.type, 'GraphQLError')
              assert.ok(Object.hasOwn(spanEvents[0].attributes, 'stacktrace'))
              assert.strictEqual(spanEvents[0].attributes.message, 'Field "address" of ' +
                'type "Address" must have a selection of subfields. Did you mean "address { ... }"?')
              assert.strictEqual(spanEvents[0].attributes.locations.length, 1)
              assert.strictEqual(spanEvents[0].attributes.locations[0], '1:11')
            })
            .then(done)
            .catch(done)

          const errors = graphql.validate(schema, document)
        })

        it('should handle execution exceptions', done => {
          const source = '{ hello }'
          const document = graphql.parse(source)

          let error

          agent
            .assertSomeTraces(traces => {
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
            .then(done)
            .catch(done)

          try {
            graphql.execute(null, document)
          } catch (e) {
            error = e
          }
        })

        it('should handle execution errors', done => {
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
            }
          }

          let error

          agent
            .assertSomeTraces(traces => {
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
              assert.ok(Object.hasOwn(spanEvents[0], 'startTime'))
              assert.strictEqual(spanEvents[0].name, 'dd.graphql.query.error')
              assert.strictEqual(spanEvents[0].attributes.type, 'GraphQLError')
              assert.ok(Object.hasOwn(spanEvents[0].attributes, 'stacktrace'))
              assert.strictEqual(spanEvents[0].attributes.message, 'test')
              assert.strictEqual(spanEvents[0].attributes.locations.length, 1)
              assert.strictEqual(spanEvents[0].attributes.locations[0], '1:3')
              assert.strictEqual(spanEvents[0].attributes.path.length, 1)
              assert.strictEqual(spanEvents[0].attributes.path[0], 'hello')
            })
            .then(done)
            .catch(done)

          Promise.resolve(graphql.execute({ schema, document, rootValue }))
            .then(res => {
              error = res.errors[0]
            })
        })

        it('should handle resolver exceptions', done => {
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
            }
          }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
              assert.strictEqual(spans[1].error, 1)
              assert.strictEqual(spans[1].meta[ERROR_TYPE], error.name)
              assert.strictEqual(spans[1].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(spans[1].meta[ERROR_STACK], error.stack)
              assert.strictEqual(spans[1].meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, rootValue }).catch(done)
        })

        it('should handle rejected promises', done => {
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
            }
          }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
              assert.strictEqual(spans[1].error, 1)
              assert.strictEqual(spans[1].meta[ERROR_TYPE], error.name)
              assert.strictEqual(spans[1].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(spans[1].meta[ERROR_STACK], error.stack)
              assert.strictEqual(spans[1].meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, rootValue }).catch(done)
        })

        it('should support multiple executions with the same contextValue', done => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = '{ hello }'

          const rootValue = {
            hello: () => 'world'
          }

          const contextValue = {}

          graphql.graphql({ schema, source, rootValue, contextValue })
            .then(() => graphql.graphql({ schema, source, rootValue, contextValue }))
            .then(() => done())
            .catch(done)
        })

        it('should support multiple executions on a pre-parsed document', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const document = graphql.parse(source)
          assert.doesNotThrow(() => {
            graphql.execute({ schema, document })
            graphql.execute({ schema, document })
          })
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
            assert.doesNotThrow(() => {
              graphql.execute({ schema, document })
            })
          } finally {
            dc.channel('datadog:graphql:resolver:start').unsubscribe(noop)
          }
        })

        it('should support multiple validations on a pre-parsed document', () => {
          const source = 'query MyQuery { hello(name: "world") }'
          const document = graphql.parse(source)

          assert.doesNotThrow(() => {
            graphql.validate(schema, document)
            graphql.validate(schema, document)
          })
        })

        it('should support multi-operations documents', done => {
          const source = `
            query FirstQuery { hello(name: "world") }
            query SecondQuery { hello(name: "world") }
          `

          const operationName = 'SecondQuery'
          const variableValues = { who: 'world' }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].service, expectedSchema.server.serviceName)
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[0].resource, 'query SecondQuery{hello(name:"")}')
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
              assert.strictEqual(spans[0].meta['graphql.operation.type'], 'query')
              assert.strictEqual(spans[0].meta['graphql.operation.name'], 'SecondQuery')
              assert.strictEqual(spans[0].meta.component, 'graphql')
            })
            .then(() => done())
            .catch(done)

          graphql.graphql({ schema, source, variableValues, operationName }).catch(done)
        })

        it('should include used fragments in the source', done => {
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

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              const resource = 'query WithFragments{human{...firstFields}}fragment firstFields on Human{name}'

              assert.strictEqual(spans[0].service, 'test')
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[0].resource, resource)
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
              assert.strictEqual(spans[0].meta['graphql.operation.type'], 'query')
              assert.strictEqual(spans[0].meta['graphql.operation.name'], 'WithFragments')
              assert.strictEqual(spans[0].meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should handle single fragment definitions', done => {
          const source = `
            fragment firstFields on Human {
              name
            }
          `

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].service, 'test')
              assert.strictEqual(spans[0].name, 'graphql.parse')
              assert.strictEqual(spans[0].resource, 'graphql.parse')
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.operation.type'))
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.operation.name'))
              assert.strictEqual(spans[0].meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        // https://github.com/graphql/graphql-js/pull/2904
        if (!semver.intersects(version, '>=16')) {
          it('should instrument using positional arguments', done => {
            const source = 'query MyQuery { hello(name: "world") }'
            const variableValues = { who: 'world' }

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].service, expectedSchema.server.serviceName)
                assert.strictEqual(spans[0].name, expectedSchema.server.opName)
                assert.strictEqual(spans[0].resource, 'query MyQuery{hello(name:"")}')
                assert.strictEqual(spans[0].type, 'graphql')
                assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
                assert.strictEqual(spans[0].meta['graphql.operation.type'], 'query')
                assert.strictEqual(spans[0].meta['graphql.operation.name'], 'MyQuery')
                assert.strictEqual(spans[0].meta.component, 'graphql')
              })
              .then(done)
              .catch(done)

            graphql.graphql(schema, source, null, null, variableValues).catch(done)
          })
        } else {
          it('should not support positional arguments', done => {
            const source = 'query MyQuery { hello(name: "world") }'
            const variableValues = { who: 'world' }

            graphql.graphql(schema, source, null, null, variableValues)
              .then(() => done(new Error('Expected error.')), () => done())
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
        //       assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))
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
            variables: variables => Object.assign({}, variables, { who: 'REDACTED' }),
            source: true
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should be configured with the correct values', done => {
          const source = '{ hello(name: "world") }'

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 2)
              assert.strictEqual(spans[0].service, 'custom')
              assert.strictEqual(spans[1].service, 'custom')
              assert.strictEqual(spans[0].meta['graphql.source'], '{ hello(name: "world") }')
              assert.strictEqual(spans[0].meta.component, 'graphql')
              assert.strictEqual(spans[1].meta['graphql.source'], 'hello(name: "world")')
              assert.strictEqual(spans[1].meta.component, 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should apply the filter callback to the variables', done => {
          const source = `
            query MyQuery($title: String!, $who: String!) {
              hello(title: $title, name: $who)
            }
          `
          const variableValues = { title: 'planet', who: 'world' }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].meta['graphql.variables.title'], 'planet')
              assert.strictEqual(spans[0].meta['graphql.variables.who'], 'REDACTED')
              assert.strictEqual(spans[1].meta['graphql.variables.title'], 'planet')
              assert.strictEqual(spans[1].meta['graphql.variables.who'], 'REDACTED')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })
      })

      describe('with an array of variable names', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', {
            variables: ['title']
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should only include the configured variables', done => {
          const source = `
            query MyQuery($title: String!, $who: String!) {
              hello(title: $title, name: $who)
            }
          `
          const variableValues = { title: 'planet', who: 'world' }

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].meta['graphql.variables.title'], 'planet')
              assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.variables.who'))
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })
      })

      describe('with a depth of 0', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { depth: 0 })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should only instrument the execution', done => {
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

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 1)
              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
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
                expect(span.context()).to.have.property('_name', expectedSchema.server.opName)
                done()
              } catch (e) {
                done(e)
              }
            }
          }

          graphql.graphql({ schema, source, rootValue }).catch(done)
        })
      })

      describe('with a depth >=1', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { depth: 2 })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should only instrument up to the specified depth', done => {
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

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])
              const ignored = spans.filter(span => {
                return [
                  'human.address.civicNumber',
                  'human.address.street'
                ].indexOf(span.resource) !== -1
              })

              assert.strictEqual(spans.length, 5)
              assert.strictEqual(ignored.length, 0)
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })
      })

      describe('with collapsing disabled', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { collapse: false })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should not collapse list field resolvers', done => {
          const source = '{ friends { name } }'

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans.length, 4)

              const execute = spans[0]
              const friends = spans[1]
              const friend0Name = spans[2]
              const friend1Name = spans[3]

              assert.strictEqual(execute.name, expectedSchema.server.opName)

              assert.strictEqual(friends.name, 'graphql.resolve')
              assert.strictEqual(friends.resource, 'friends:[Human]')
              assert.strictEqual(friends.meta['graphql.field.path'], 'friends')
              assert.strictEqual(friends.parent_id.toString(), execute.span_id.toString())

              assert.strictEqual(friend0Name.name, 'graphql.resolve')
              assert.strictEqual(friend0Name.resource, 'name:String')
              assert.strictEqual(friend0Name.meta['graphql.field.path'], 'friends.0.name')
              assert.strictEqual(friend0Name.parent_id.toString(), friends.span_id.toString())

              assert.strictEqual(friend1Name.name, 'graphql.resolve')
              assert.strictEqual(friend1Name.resource, 'name:String')
              assert.strictEqual(friend1Name.meta['graphql.field.path'], 'friends.1.name')
              assert.strictEqual(friend1Name.parent_id.toString(), friends.span_id.toString())
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })
      })

      describe('with signature calculation disabled', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql', { signature: false })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          graphql = require(`../../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should fallback to the operation type and name', done => {
          const source = 'query WithoutSignature { friends { name } }'

          agent
            .assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].name, expectedSchema.server.opName)
              assert.strictEqual(spans[0].resource, 'query WithoutSignature')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })
      })

      describe('with hooks configuration', () => {
        const config = {
          hooks: {
            execute: sinon.spy((span, context, res) => {}),
            parse: sinon.spy((span, document, operation) => {}),
            validate: sinon.spy((span, document, error) => {})
          }
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

        after(() => agent.close({ ritmReset: false }))

        it('should run the execute hook before graphql.execute span is finished', done => {
          const document = graphql.parse(source)

          graphql.validate(schema, document)

          const params = {
            schema,
            document,
            rootValue: {
              hello: () => 'world'
            },
            contextValue: {},
            variableValues: { who: 'world' },
            operationName: 'MyQuery',
            fieldResolver: (source, args, contextValue, info) => args.name,
            typeResolver: (value, context, info, abstractType) => 'Query'
          }

          let result

          agent
            .assertSomeTraces(traces => {
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
                fieldResolver: params.fieldResolver,
                typeResolver: params.typeResolver
              })
              assert.strictEqual(res, result)
            })
            .then(done)
            .catch(done)

          Promise.resolve(graphql.execute(params))
            .then(res => {
              result = res
            })
        })

        it('should run the validate hook before graphql.validate span is finished', done => {
          const document = graphql.parse(source)

          agent
            .assertSomeTraces(traces => {
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
            .then(done)
            .catch(done)
          const errors = graphql.validate(schema, document)
        })

        it('should run the parse hook before graphql.parse span is finished', done => {
          let document

          agent
            .assertSomeTraces(traces => {
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
            .then(done)
            .catch(done)

          Promise.resolve(graphql.parse(source))
            .then(res => {
              document = res
            })
        })
      })

      withVersions(plugin, 'apollo-server-core', apolloVersion => {
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
            return agent.close({ ritmReset: false })
          })

          it('should support apollo-server schema stitching', done => {
            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans.length, 3)

                assert.strictEqual(spans[0].name, expectedSchema.server.opName)
                assert.strictEqual(spans[0].resource, 'query MyQuery{hello}')
                assert.ok(!Object.hasOwn(spans[0].meta, 'graphql.source'))

                assert.strictEqual(spans[1].name, 'graphql.resolve')
                assert.strictEqual(spans[1].resource, 'hello:String')

                assert.strictEqual(spans[2].name, 'graphql.validate')
                assert.ok(!Object.hasOwn(spans[2].meta, 'graphql.source'))
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
                      hello: () => 'Hello world!'
                    }
                  }
                }),
                makeExecutableSchema({
                  typeDefs: `
                type Query {
                  world: String
                }
              `,
                  resolvers: {
                    Query: {
                      world: () => 'Hello world!'
                    }
                  }
                })
              ]
            })

            const params = {
              schema,
              query: 'query MyQuery { hello }',
              operationName: 'MyQuery'
            }

            runQuery(params)
              .catch(done)
          })
        })
      })
    })
  })
})
