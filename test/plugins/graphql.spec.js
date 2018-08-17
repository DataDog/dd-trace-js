'use strict'

const agent = require('./agent')
const plugin = require('../../src/plugins/graphql')

wrapIt()

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
          type: new graphql.GraphQLList(new graphql.GraphQLObjectType({
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
          })),
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
    withVersions(plugin, 'graphql', version => {
      beforeEach(() => {
        tracer = require('../..')

        sort = spans => spans.sort((a, b) => a.start.toString() > b.start.toString() ? 1 : -1)
      })

      afterEach(() => {
        agent.close()
        agent.wipe()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'graphql')
            .then(() => {
              graphql = require(`./versions/graphql@${version}`).get()
              buildSchema()
            })
        })

        it('should instrument operations', done => {
          const source = `query MyQuery { hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)
              expect(spans[0]).to.have.property('service', 'test-graphql')
              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[0]).to.have.property('resource', 'query MyQuery')
              expect(spans[0].meta).to.have.property('graphql.document', source)
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument fields', done => {
          const source = `{ hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)
              expect(spans[1]).to.have.property('service', 'test-graphql')
              expect(spans[1]).to.have.property('name', 'graphql.field')
              expect(spans[1]).to.have.property('resource', 'hello')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument schema resolvers', done => {
          const source = `{ hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)
              expect(spans[2]).to.have.property('service', 'test-graphql')
              expect(spans[2]).to.have.property('name', 'graphql.resolve')
              expect(spans[2]).to.have.property('resource', 'hello')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
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

              expect(spans).to.have.length(11)

              const query = spans[0]
              const humanField = spans[1]
              const humanResolve = spans[2]
              const humanNameField = spans[3]
              const humanNameResolve = spans[4]
              const addressField = spans[5]
              const addressResolve = spans[6]
              const addressCivicNumberField = spans[7]
              const addressCivicNumberResolve = spans[8]
              const addressStreetField = spans[9]
              const addressStreetResolve = spans[10]

              expect(query).to.have.property('name', 'graphql.query')
              expect(query).to.have.property('resource', 'query')

              expect(humanField).to.have.property('name', 'graphql.field')
              expect(humanField).to.have.property('resource', 'human')
              expect(humanField.parent_id.toString()).to.equal(query.span_id.toString())
              expect(humanField.duration.toNumber()).to.be.lte(query.duration.toNumber())

              expect(humanResolve).to.have.property('name', 'graphql.resolve')
              expect(humanResolve).to.have.property('resource', 'human')
              expect(humanResolve.parent_id.toString()).to.equal(humanField.span_id.toString())
              expect(humanResolve.duration.toNumber()).to.be.lte(humanField.duration.toNumber())

              expect(humanNameField).to.have.property('name', 'graphql.field')
              expect(humanNameField).to.have.property('resource', 'human.name')
              expect(humanNameField.parent_id.toString()).to.equal(humanField.span_id.toString())

              expect(humanNameResolve).to.have.property('name', 'graphql.resolve')
              expect(humanNameResolve).to.have.property('resource', 'human.name')
              expect(humanNameResolve.parent_id.toString()).to.equal(humanNameField.span_id.toString())

              expect(addressField).to.have.property('name', 'graphql.field')
              expect(addressField).to.have.property('resource', 'human.address')
              expect(addressField.parent_id.toString()).to.equal(humanField.span_id.toString())
              expect(addressField.duration.toNumber()).to.be.lte(humanField.duration.toNumber())

              expect(addressResolve).to.have.property('name', 'graphql.resolve')
              expect(addressResolve).to.have.property('resource', 'human.address')
              expect(addressResolve.parent_id.toString()).to.equal(addressField.span_id.toString())
              expect(addressResolve.duration.toNumber()).to.be.lte(addressField.duration.toNumber())

              expect(addressCivicNumberField).to.have.property('name', 'graphql.field')
              expect(addressCivicNumberField).to.have.property('resource', 'human.address.civicNumber')
              expect(addressCivicNumberField.parent_id.toString()).to.equal(addressField.span_id.toString())
              expect(addressCivicNumberField.duration.toNumber()).to.be.lte(addressField.duration.toNumber())

              expect(addressCivicNumberResolve).to.have.property('name', 'graphql.resolve')
              expect(addressCivicNumberResolve).to.have.property('resource', 'human.address.civicNumber')
              expect(addressCivicNumberResolve.parent_id.toString())
                .to.equal(addressCivicNumberField.span_id.toString())
              expect(addressCivicNumberResolve.duration.toNumber())
                .to.be.lte(addressCivicNumberField.duration.toNumber())

              expect(addressStreetField).to.have.property('name', 'graphql.field')
              expect(addressStreetField).to.have.property('resource', 'human.address.street')
              expect(addressStreetField.parent_id.toString()).to.equal(addressField.span_id.toString())
              expect(addressStreetField.duration.toNumber()).to.be.lte(addressField.duration.toNumber())

              expect(addressStreetResolve).to.have.property('name', 'graphql.resolve')
              expect(addressStreetResolve).to.have.property('resource', 'human.address.street')
              expect(addressStreetResolve.parent_id.toString()).to.equal(addressStreetField.span_id.toString())
              expect(addressStreetResolve.duration.toNumber()).to.be.lte(addressStreetField.duration.toNumber())
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument list field resolvers', done => {
          const source = `{ friends { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(7)

              const query = spans[0]
              const friendsField = spans[1]
              const friendsResolve = spans[2]
              const friend0NameField = spans[3]
              const friend0NameResolve = spans[4]
              const friend1NameField = spans[5]
              const friend1NameResolve = spans[6]

              expect(query).to.have.property('name', 'graphql.query')
              expect(query).to.have.property('resource', 'query')

              expect(friendsField).to.have.property('name', 'graphql.field')
              expect(friendsField).to.have.property('resource', 'friends')
              expect(friendsField.parent_id.toString()).to.equal(query.span_id.toString())

              expect(friendsResolve).to.have.property('name', 'graphql.resolve')
              expect(friendsResolve).to.have.property('resource', 'friends')
              expect(friendsResolve.parent_id.toString()).to.equal(friendsField.span_id.toString())

              expect(friend0NameField).to.have.property('name', 'graphql.field')
              expect(friend0NameField).to.have.property('resource', 'friends.0.name')
              expect(friend0NameField.parent_id.toString()).to.equal(friendsField.span_id.toString())

              expect(friend0NameResolve).to.have.property('name', 'graphql.resolve')
              expect(friend0NameResolve).to.have.property('resource', 'friends.0.name')
              expect(friend0NameResolve.parent_id.toString()).to.equal(friend0NameField.span_id.toString())

              expect(friend1NameField).to.have.property('name', 'graphql.field')
              expect(friend1NameField).to.have.property('resource', 'friends.1.name')
              expect(friend1NameField.parent_id.toString()).to.equal(friendsField.span_id.toString())

              expect(friend1NameResolve).to.have.property('name', 'graphql.resolve')
              expect(friend1NameResolve).to.have.property('resource', 'friends.1.name')
              expect(friend1NameResolve.parent_id.toString()).to.equal(friend1NameField.span_id.toString())
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument mutations', done => {
          const source = `mutation { human { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(5)
              expect(spans[0]).to.have.property('name', 'graphql.mutation')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should handle a circular schema', done => {
          const source = `{ human { pets { owner { name } } } }`

          graphql.graphql(schema, source)
            .then((result) => {
              expect(result.data.human.pets[0].owner.name).to.equal('test')

              done()
            })
            .catch(done)
        })

        it('should ignore the default field resolver', done => {
          const schema = graphql.buildSchema(`
            type Query {
              hello: String
            }
          `)

          const source = `{ hello }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('resource', 'query')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source, { hello: 'world' }).catch(done)
        })

        it('should ignore the execution field resolver without a rootValue resolver', done => {
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

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('resource', 'query')
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

                expect(spans).to.have.length(3)
              })
              .then(done)
              .catch(done)

            graphql.graphql(schema, source).catch(done)
          })

          graphql.graphql(schema, source).catch(done)
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
              expect(tracer.scopeManager().active()).to.not.be.null
              done()
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
          const scope = tracer.scopeManager().activate(span)

          return graphql.graphql({ schema, source, rootValue })
            .then(value => {
              expect(value).to.have.nested.property('data.hello', 'test')
              expect(tracer.scopeManager().active()).to.equal(scope)
            })
        })

        it('should handle unsupported operations', () => {
          const query = `query MyQuery { hello(name: "world") }`
          const subscription = `subscription { human { name } }`

          return graphql.graphql(schema, query)
            .then(() => graphql.graphql(schema, subscription))
            .then(result => {
              expect(result).to.not.have.property('errors')
            })
        })

        it('should handle calling low level APIs directly', done => {
          const source = `query MyQuery { hello(name: "world") }`
          const document = graphql.parse(source)

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)
              expect(spans[0]).to.have.property('service', 'test-graphql')
              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[0]).to.have.property('resource', 'query MyQuery')
              expect(spans[0].meta).to.have.property('graphql.document', source)
            })
            .then(done)
            .catch(done)

          graphql.execute({ schema, document })
        })

        it('should handle Source objects', done => {
          const source = `query MyQuery { hello(name: "world") }`
          const document = graphql.parse(new graphql.Source(source))

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)
              expect(spans[0]).to.have.property('service', 'test-graphql')
              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[0]).to.have.property('resource', 'query MyQuery')
              expect(spans[0].meta).to.have.property('graphql.document', source)
            })
            .then(done)
            .catch(done)

          graphql.execute(schema, document)
        })

        it('should handle executor exceptions', done => {
          schema = new graphql.GraphQLSchema({
            query: new graphql.GraphQLObjectType({
              name: 'RootQueryType',
              fields: {
                hello: {}
              }
            })
          })

          const source = `{ hello }`
          const document = graphql.parse(source)

          let error

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(1)
              expect(spans[0]).to.have.property('service', 'test-graphql')
              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[0]).to.have.property('resource', 'query')
              expect(spans[0].meta).to.have.property('graphql.document', source)
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property('error.type', error.name)
              expect(spans[0].meta).to.have.property('error.msg', error.message)
              expect(spans[0].meta).to.have.property('error.stack', error.stack)
            })
            .then(done)
            .catch(done)

          try {
            graphql.execute(schema, document)
          } catch (e) {
            error = e
          }
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

              expect(spans).to.have.length(3)
              expect(spans[2]).to.have.property('error', 1)
              expect(spans[2].meta).to.have.property('error.type', error.name)
              expect(spans[2].meta).to.have.property('error.msg', error.message)
              expect(spans[2].meta).to.have.property('error.stack', error.stack)
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

              expect(spans).to.have.length(3)
              expect(spans[2]).to.have.property('error', 1)
              expect(spans[2].meta).to.have.property('error.type', error.name)
              expect(spans[2].meta).to.have.property('error.msg', error.message)
              expect(spans[2].meta).to.have.property('error.stack', error.stack)
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
      })

      describe('with configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'graphql', { service: 'test' })
            .then(() => {
              graphql = require(`./versions/graphql@${version}`).get()
              buildSchema()
            })
        })

        it('should be configured with the correct values', done => {
          const source = `{ hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)
              expect(spans[2]).to.have.property('service', 'test')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })
      })
    })
  })
})
