'use strict'

const { expect } = require('chai')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

describe('Plugin', () => {
  let tracer
  let graphql
  let schema
  let sort

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
              return [ { name: 'alice' }, { name: 'bob' } ]
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
            'graphql.execute',
            'graphql.field',
            'graphql.resolve'
          ]

          if (a.start.toString() === b.start.toString()) {
            return order.indexOf(a.name) - order.indexOf(b.name)
          }

          return a.start.toString() >= b.start.toString() ? 1 : -1
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

        it('should instrument parsing', done => {
          const source = `query MyQuery { hello(name: "world") }`
          const variableValues = { who: 'world' }

          agent
            .use(traces => {
              const span = traces[0][0]

              expect(span).to.have.property('service', 'test')
              expect(span).to.have.property('name', 'graphql.parse')
              expect(span).to.have.property('resource', 'graphql.parse')
              expect(span).to.have.property('type', 'graphql')
              expect(span).to.have.property('error', 0)
              expect(span.meta).to.not.have.property('graphql.source')
              expect(span.meta).to.have.property('component', 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should instrument validation', done => {
          const source = `query MyQuery { hello(name: "world") }`
          const variableValues = { who: 'world' }

          agent
            .use(traces => {
              const span = traces[0][0]

              expect(span).to.have.property('service', 'test')
              expect(span).to.have.property('name', 'graphql.validate')
              expect(span).to.have.property('resource', 'graphql.validate')
              expect(span).to.have.property('type', 'graphql')
              expect(span).to.have.property('error', 0)
              expect(span.meta).to.not.have.property('graphql.source')
              expect(span.meta).to.have.property('component', 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should instrument execution', done => {
          const source = `query MyQuery { hello(name: "world") }`
          const variableValues = { who: 'world' }

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('resource', 'query MyQuery{hello(name:"")}')
              expect(spans[0]).to.have.property('type', 'graphql')
              expect(spans[0]).to.have.property('error', 0)
              expect(spans[0].meta).to.not.have.property('graphql.source')
              expect(spans[0].meta).to.have.property('graphql.operation.type', 'query')
              expect(spans[0].meta).to.have.property('graphql.operation.name', 'MyQuery')
              expect(spans[0].meta).to.have.property('component', 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should not include variables by default', done => {
          const source = `query MyQuery($who: String!) { hello(name: $who) }`
          const variableValues = { who: 'world' }

          agent
            .use(traces => {
              const spans = sort(traces[0])
              expect(spans[0].meta).to.not.have.property('graphql.variables')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, variableValues }).catch(done)
        })

        it('should instrument schema resolvers', done => {
          const source = `{ hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[1]).to.have.property('service', 'test')
              expect(spans[1]).to.have.property('name', 'graphql.resolve')
              expect(spans[1]).to.have.property('resource', 'hello:String')
              expect(spans[1]).to.have.property('type', 'graphql')
              expect(spans[1]).to.have.property('error', 0)
              expect(Number(spans[1].duration)).to.be.gt(0)
              expect(spans[1].meta).to.have.property('graphql.field.name', 'hello')
              expect(spans[1].meta).to.have.property('graphql.field.path', 'hello')
              expect(spans[1].meta).to.have.property('graphql.field.type', 'String')
              expect(spans[1].meta).to.not.have.property('graphql.source')
              expect(spans[1].meta).to.have.property('component', 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
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
            .use(traces => {
              const spans = sort(traces[0])
              expect(spans).to.have.length(6)

              const execute = spans[0]
              const human = spans[1]
              const humanName = spans[2]
              const address = spans[3]
              const addressCivicNumber = spans[4]
              const addressStreet = spans[5]

              expect(execute).to.have.property('name', 'graphql.execute')
              expect(execute).to.have.property('error', 0)

              expect(human).to.have.property('name', 'graphql.resolve')
              expect(human).to.have.property('resource', 'human:Human')
              expect(human).to.have.property('error', 0)
              expect(human.meta).to.have.property('graphql.field.path', 'human')
              expect(human.parent_id.toString()).to.equal(execute.span_id.toString())

              expect(humanName).to.have.property('name', 'graphql.resolve')
              expect(humanName).to.have.property('resource', 'name:String')
              expect(humanName).to.have.property('error', 0)
              expect(humanName.meta).to.have.property('graphql.field.path', 'human.name')
              expect(humanName.parent_id.toString()).to.equal(human.span_id.toString())

              expect(address).to.have.property('name', 'graphql.resolve')
              expect(address).to.have.property('resource', 'address:Address')
              expect(address).to.have.property('error', 0)
              expect(address.meta).to.have.property('graphql.field.path', 'human.address')
              expect(address.parent_id.toString()).to.equal(human.span_id.toString())

              expect(addressCivicNumber).to.have.property('name', 'graphql.resolve')
              expect(addressCivicNumber).to.have.property('resource', 'civicNumber:String')
              expect(addressCivicNumber).to.have.property('error', 0)
              expect(addressCivicNumber.meta).to.have.property('graphql.field.path', 'human.address.civicNumber')
              expect(addressCivicNumber.parent_id.toString()).to.equal(address.span_id.toString())

              expect(addressStreet).to.have.property('name', 'graphql.resolve')
              expect(addressStreet).to.have.property('resource', 'street:String')
              expect(addressStreet).to.have.property('error', 0)
              expect(addressStreet.meta).to.have.property('graphql.field.path', 'human.address.street')
              expect(addressStreet.parent_id.toString()).to.equal(address.span_id.toString())
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(5)

              const execute = spans[0]
              const friends = spans[1]
              const friendsName = spans[2]
              const pets = spans[3]
              const petsName = spans[4]

              expect(execute).to.have.property('name', 'graphql.execute')

              expect(friends).to.have.property('name', 'graphql.resolve')
              expect(friends).to.have.property('resource', 'friends:[Human]')
              expect(friends.meta).to.have.property('graphql.field.path', 'friends')
              expect(friends.parent_id.toString()).to.equal(execute.span_id.toString())

              expect(friendsName).to.have.property('name', 'graphql.resolve')
              expect(friendsName).to.have.property('resource', 'name:String')
              expect(friendsName.meta).to.have.property('graphql.field.path', 'friends.*.name')
              expect(friendsName.parent_id.toString()).to.equal(friends.span_id.toString())

              expect(pets).to.have.property('name', 'graphql.resolve')
              expect(pets).to.have.property('resource', 'pets:[Pet!]')
              expect(pets.meta).to.have.property('graphql.field.path', 'friends.*.pets')
              expect(pets.parent_id.toString()).to.equal(friends.span_id.toString())

              expect(petsName).to.have.property('name', 'graphql.resolve')
              expect(petsName).to.have.property('resource', 'name:String')
              expect(petsName.meta).to.have.property('graphql.field.path', 'friends.*.pets.*.name')
              expect(petsName.parent_id.toString()).to.equal(pets.span_id.toString())
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should instrument mutations', done => {
          const source = `mutation { human { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].meta).to.have.property('graphql.operation.type', 'mutation')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should instrument subscriptions', done => {
          const source = `subscription { human { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].meta).to.have.property('graphql.operation.type', 'subscription')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should handle a circular schema', done => {
          const source = `{ human { pets { owner { name } } } }`

          graphql.graphql({ schema, source })
            .then((result) => {
              expect(result.data.human.pets[0].owner.name).to.equal('test')
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

          const source = `{ hello }`
          const rootValue = { hello: 'world' }

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[1]).to.have.property('name', 'graphql.resolve')
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

          const source = `{ hello }`

          const rootValue = { hello: 'world' }

          const fieldResolver = (source, args, contextValue, info) => {
            return source[info.fieldName]
          }

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[1]).to.have.property('name', 'graphql.resolve')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source, rootValue, fieldResolver }).catch(done)
        })

        it('should not instrument schema resolvers multiple times', done => {
          const source = `{ hello(name: "world") }`

          agent.use(() => { // skip first call
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans).to.have.length(2)
              })
              .then(done)
              .catch(done)

            graphql.graphql({ schema, source }).catch(done)
          })

          graphql.graphql({ schema, source }).catch(done)
        })

        it('should run parsing, validation and execution in the current context', done => {
          const source = `query MyQuery { hello(name: "world") }`
          const variableValues = { who: 'world' }
          const span = tracer.startSpan('test.request')

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(5)

              expect(spans[0]).to.have.property('name', 'test.request')

              expect(spans[1]).to.have.property('service', 'test')
              expect(spans[1]).to.have.property('name', 'graphql.parse')

              expect(spans[2]).to.have.property('service', 'test')
              expect(spans[2]).to.have.property('name', 'graphql.validate')

              expect(spans[3]).to.have.property('service', 'test')
              expect(spans[3]).to.have.property('name', 'graphql.execute')
              expect(spans[3]).to.have.property('resource', 'query MyQuery{hello(name:"")}')

              expect(spans[4]).to.have.property('service', 'test')
              expect(spans[4]).to.have.property('name', 'graphql.resolve')
              expect(spans[4]).to.have.property('resource', 'hello:String')
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

          const source = `{ hello }`

          const rootValue = {
            hello () {
              try {
                expect(tracer.scope().active()).to.not.be.null
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

          const source = `{ hello }`

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
                expect(tracer.scope().active()).to.equal(span)
              })
          })
        })

        it('should handle unsupported operations', () => {
          const source = `query MyQuery { hello(name: "world") }`
          const subscription = `subscription { human { name } }`

          return graphql.graphql({ schema, source })
            .then(() => graphql.graphql({ schema, source: subscription }))
            .then(result => {
              expect(result).to.not.have.property('errors')
            })
        })

        it('should handle calling low level APIs directly', done => {
          const source = `query MyQuery { hello(name: "world") }`

          Promise
            .all([
              agent.use(traces => {
                const spans = sort(traces[0])
                expect(spans[0]).to.have.property('name', 'graphql.parse')
              }),
              agent.use(traces => {
                const spans = sort(traces[0])
                expect(spans[0]).to.have.property('name', 'graphql.validate')
              }),
              agent.use(traces => {
                const spans = sort(traces[0])
                expect(spans[0]).to.have.property('name', 'graphql.execute')
                expect(spans[1]).to.have.property('name', 'graphql.resolve')
              })
            ])
            .then(() => done())
            .catch(done)

          // These are the 3 lower-level steps
          const document = graphql.parse(source)
          graphql.validate(schema, document)
          graphql.execute({ schema, document })
        })

        it('should handle Source objects', done => {
          const source = `query MyQuery { hello(name: "world") }`
          const document = graphql.parse(new graphql.Source(source))

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('resource', 'query MyQuery{hello(name:"")}')
              expect(spans[0].meta).to.not.have.property('graphql.source')
              expect(spans[0].meta).to.have.property('component', 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.execute({ schema, document })
        })

        it('should handle parsing exceptions', done => {
          let error

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.parse')
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(spans[0].meta).to.have.property('component', 'graphql')
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.validate')
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(spans[0].meta).to.have.property('component', 'graphql')
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
          const source = `{ human { address } }`
          const document = graphql.parse(source)

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.validate')
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property(ERROR_TYPE, errors[0].name)
              expect(spans[0].meta).to.have.property(ERROR_MESSAGE, errors[0].message)
              expect(spans[0].meta).to.have.property(ERROR_STACK, errors[0].stack)
              expect(spans[0].meta).to.have.property('component', 'graphql')
            })
            .then(done)
            .catch(done)

          const errors = graphql.validate(schema, document)
        })

        it('should handle execution exceptions', done => {
          const source = `{ hello }`
          const document = graphql.parse(source)

          let error

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(spans[0].meta).to.have.property('component', 'graphql')
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
          const source = `{ hello }`
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(spans[0].meta).to.have.property('component', 'graphql')
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

          const source = `{ hello }`

          const rootValue = {
            hello: () => {
              throw error
            }
          }

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[1]).to.have.property('error', 1)
              expect(spans[1].meta).to.have.property(ERROR_TYPE, error.name)
              expect(spans[1].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(spans[1].meta).to.have.property(ERROR_STACK, error.stack)
              expect(spans[1].meta).to.have.property('component', 'graphql')
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

          const source = `{ hello }`

          const rootValue = {
            hello: () => {
              return Promise.reject(error)
            }
          }

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[1]).to.have.property('error', 1)
              expect(spans[1].meta).to.have.property(ERROR_TYPE, error.name)
              expect(spans[1].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(spans[1].meta).to.have.property(ERROR_STACK, error.stack)
              expect(spans[1].meta).to.have.property('component', 'graphql')
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

          const source = `{ hello }`

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
          const source = `query MyQuery { hello(name: "world") }`
          const document = graphql.parse(source)

          expect(() => {
            graphql.execute({ schema, document })
            graphql.execute({ schema, document })
          }).to.not.throw()
        })

        it('should support multiple validations on a pre-parsed document', () => {
          const source = `query MyQuery { hello(name: "world") }`
          const document = graphql.parse(source)

          expect(() => {
            graphql.validate(schema, document)
            graphql.validate(schema, document)
          }).to.not.throw()
        })

        it('should support multi-operations documents', done => {
          const source = `
            query FirstQuery { hello(name: "world") }
            query SecondQuery { hello(name: "world") }
          `

          const operationName = 'SecondQuery'
          const variableValues = { who: 'world' }

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('resource', 'query SecondQuery{hello(name:"")}')
              expect(spans[0].meta).to.not.have.property('graphql.source')
              expect(spans[0].meta).to.have.property('graphql.operation.type', 'query')
              expect(spans[0].meta).to.have.property('graphql.operation.name', 'SecondQuery')
              expect(spans[0].meta).to.have.property('component', 'graphql')
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
            .use(traces => {
              const spans = sort(traces[0])

              const resource = 'query WithFragments{human{...firstFields}}fragment firstFields on Human{name}'

              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('resource', resource)
              expect(spans[0].meta).to.not.have.property('graphql.source')
              expect(spans[0].meta).to.have.property('graphql.operation.type', 'query')
              expect(spans[0].meta).to.have.property('graphql.operation.name', 'WithFragments')
              expect(spans[0].meta).to.have.property('component', 'graphql')
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('name', 'graphql.parse')
              expect(spans[0]).to.have.property('resource', 'graphql.parse')
              expect(spans[0].meta).to.not.have.property('graphql.source')
              expect(spans[0].meta).to.not.have.property('graphql.operation.type')
              expect(spans[0].meta).to.not.have.property('graphql.operation.name')
              expect(spans[0].meta).to.have.property('component', 'graphql')
            })
            .then(done)
            .catch(done)

          graphql.graphql({ schema, source }).catch(done)
        })

        // https://github.com/graphql/graphql-js/pull/2904
        if (!semver.intersects(version, '>=16')) {
          it('should instrument using positional arguments', done => {
            const source = `query MyQuery { hello(name: "world") }`
            const variableValues = { who: 'world' }

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('name', 'graphql.execute')
                expect(spans[0]).to.have.property('resource', 'query MyQuery{hello(name:"")}')
                expect(spans[0]).to.have.property('type', 'graphql')
                expect(spans[0].meta).to.not.have.property('graphql.source')
                expect(spans[0].meta).to.have.property('graphql.operation.type', 'query')
                expect(spans[0].meta).to.have.property('graphql.operation.name', 'MyQuery')
                expect(spans[0].meta).to.have.property('component', 'graphql')
              })
              .then(done)
              .catch(done)

            graphql.graphql(schema, source, null, null, variableValues).catch(done)
          })
        } else {
          it('should not support positional arguments', done => {
            const source = `query MyQuery { hello(name: "world") }`
            const variableValues = { who: 'world' }

            graphql.graphql(schema, source, null, null, variableValues)
              .then(() => done(new Error('Expected error.')), () => done())
          })
        }

        // it('should not disable signature with invalid arguments', done => {
        //   agent
        //     .use(traces => {
        //       const spans = sort(traces[0])

        //       console.log(spans.map(span => `${span.name} | ${span.resource}`))
        //       const resource = 'query WithFragments{human{...firstFields}}fragment firstFields on Human{name}'

        //       expect(spans[0]).to.have.property('service', 'test')
        //       expect(spans[0]).to.have.property('name', 'graphql.execute')
        //       expect(spans[0]).to.have.property('resource', resource)
        //       expect(spans[0].meta).to.not.have.property('graphql.source')
        //       expect(spans[0].meta).to.have.property('graphql.operation.type', 'query')
        //       expect(spans[0].meta).to.have.property('graphql.operation.name', 'WithFragments')
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
            service: 'test',
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
          const source = `{ hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(2)
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[1]).to.have.property('service', 'test')
              expect(spans[0].meta).to.have.property('graphql.source', '{ hello(name: "world") }')
              expect(spans[0].meta).to.have.property('component', 'graphql')
              expect(spans[1].meta).to.have.property('graphql.source', 'hello(name: "world")')
              expect(spans[1].meta).to.have.property('component', 'graphql')
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].meta).to.have.property('graphql.variables.title', 'planet')
              expect(spans[0].meta).to.have.property('graphql.variables.who', 'REDACTED')
              expect(spans[1].meta).to.have.property('graphql.variables.title', 'planet')
              expect(spans[1].meta).to.have.property('graphql.variables.who', 'REDACTED')
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].meta).to.have.property('graphql.variables.title', 'planet')
              expect(spans[0].meta).to.not.have.property('graphql.variables.who')
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('name', 'graphql.execute')
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

          const source = `{ hello }`

          const rootValue = {
            hello () {
              const span = tracer.scope().active()

              try {
                expect(span).to.not.be.null
                expect(span.context()).to.have.property('_name', 'graphql.execute')
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
            .use(traces => {
              const spans = sort(traces[0])
              const ignored = spans.filter(span => {
                return [
                  'human.address.civicNumber',
                  'human.address.street'
                ].indexOf(span.resource) !== -1
              })

              expect(spans).to.have.length(5)
              expect(ignored).to.have.length(0)
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
          const source = `{ friends { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(4)

              const execute = spans[0]
              const friends = spans[1]
              const friend0Name = spans[2]
              const friend1Name = spans[3]

              expect(execute).to.have.property('name', 'graphql.execute')

              expect(friends).to.have.property('name', 'graphql.resolve')
              expect(friends).to.have.property('resource', 'friends:[Human]')
              expect(friends.meta).to.have.property('graphql.field.path', 'friends')
              expect(friends.parent_id.toString()).to.equal(execute.span_id.toString())

              expect(friend0Name).to.have.property('name', 'graphql.resolve')
              expect(friend0Name).to.have.property('resource', 'name:String')
              expect(friend0Name.meta).to.have.property('graphql.field.path', 'friends.0.name')
              expect(friend0Name.parent_id.toString()).to.equal(friends.span_id.toString())

              expect(friend1Name).to.have.property('name', 'graphql.resolve')
              expect(friend1Name).to.have.property('resource', 'name:String')
              expect(friend1Name.meta).to.have.property('graphql.field.path', 'friends.1.name')
              expect(friend1Name.parent_id.toString()).to.equal(friends.span_id.toString())
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
          const source = `query WithoutSignature { friends { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('resource', 'query WithoutSignature')
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(config.hooks.execute).to.have.been.calledOnce

              const span = config.hooks.execute.firstCall.args[0]
              const args = config.hooks.execute.firstCall.args[1]
              const res = config.hooks.execute.firstCall.args[2]

              expect(span.context()._name).to.equal('graphql.execute')
              expect(args).to.include({
                schema: params.schema,
                document: params.document,
                rootValue: params.rootValue,
                contextValue: params.contextValue,
                variableValues: params.variableValues,
                operationName: params.operationName,
                fieldResolver: params.fieldResolver,
                typeResolver: params.typeResolver
              })
              expect(res).to.equal(result)
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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('name', 'graphql.validate')
              expect(config.hooks.validate).to.have.been.calledOnce

              const span = config.hooks.validate.firstCall.args[0]
              const hookDocument = config.hooks.validate.firstCall.args[1]
              const hookErrors = config.hooks.validate.firstCall.args[2]

              expect(span.context()._name).to.equal('graphql.validate')

              expect(hookDocument).to.equal(document)
              expect(hookErrors).to.equal(errors)
            })
            .then(done)
            .catch(done)
          const errors = graphql.validate(schema, document)
        })

        it('should run the parse hook before graphql.parse span is finished', done => {
          let document

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('name', 'graphql.parse')
              expect(config.hooks.parse).to.have.been.calledOnce

              const span = config.hooks.parse.firstCall.args[0]
              const hookSource = config.hooks.parse.firstCall.args[1]
              const hookDocument = config.hooks.parse.firstCall.args[2]

              expect(span.context()._name).to.equal('graphql.parse')

              expect(hookSource).to.equal(source)
              expect(hookDocument).to.equal(document)
            })
            .then(done)
            .catch(done)

          Promise.resolve(graphql.parse(source))
            .then(res => {
              document = res
            })
        })
      })

      withVersions('graphql', 'apollo-server-core', apolloVersion => {
        let runQuery
        let mergeSchemas
        let makeExecutableSchema

        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('graphql')
            .then(() => {
              graphql = require(`../../../versions/graphql@${version}`).get()

              const apolloCore = require(`../../../versions/apollo-server-core@${apolloVersion}`).get()
              const graphqlTools = require(`../../../versions/graphql-tools@3.1.1`).get()

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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)

              expect(spans[0]).to.have.property('name', 'graphql.execute')
              expect(spans[0]).to.have.property('resource', 'query MyQuery{hello}')
              expect(spans[0].meta).to.not.have.property('graphql.source')

              expect(spans[1]).to.have.property('name', 'graphql.resolve')
              expect(spans[1]).to.have.property('resource', 'hello:String')

              expect(spans[2]).to.have.property('name', 'graphql.validate')
              expect(spans[2].meta).to.not.have.property('graphql.source')
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
