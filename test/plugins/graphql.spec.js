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
    withVersions(plugin, 'graphql', version => {
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
          tracer = require('../..')

          return agent.load(plugin, 'graphql')
            .then(() => {
              graphql = require(`../../versions/graphql@${version}`).get()
              buildSchema()
            })
        })

        after(() => {
          return agent.close()
        })

        it('should instrument operations', done => {
          const source = `query MyQuery { hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(6)
              expect(spans[0]).to.have.property('service', 'test-graphql')
              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[0]).to.have.property('resource', 'query MyQuery')
              expect(spans[0].meta).to.have.property('graphql.document', source)
              expect(spans[0].meta).to.have.property('graphql.operation.type', 'query')
              expect(spans[0].meta).to.have.property('graphql.operation.name', 'MyQuery')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source, null, null, { who: 'world' }).catch(done)
        })

        it('should not include variables by default', done => {
          const source = `query MyQuery($who: String!) { hello(name: $who) }`

          agent
            .use(traces => {
              const spans = sort(traces[0])
              expect(spans[0].meta).to.not.have.property('graphql.variables')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source, null, null, { who: 'world' }).catch(done)
        })

        it('should instrument fields', done => {
          const source = `{ hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(6)
              expect(spans[4]).to.have.property('service', 'test-graphql')
              expect(spans[4]).to.have.property('name', 'graphql.field')
              expect(spans[4]).to.have.property('resource', 'hello')
              expect(spans[4].meta).to.have.property('graphql.field.name', 'hello')
              expect(spans[4].meta).to.have.property('graphql.field.path', 'hello')
              expect(spans[4].meta).to.have.property('graphql.field.type', 'String')
              expect(spans[4].meta).to.have.property('graphql.field.source', 'hello(name: "world")')
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

              expect(spans).to.have.length(6)
              expect(spans[5]).to.have.property('service', 'test-graphql')
              expect(spans[5]).to.have.property('name', 'graphql.resolve')
              expect(spans[5]).to.have.property('resource', 'hello')
              expect(spans[5].meta).to.have.property('graphql.field.name', 'hello')
              expect(spans[5].meta).to.have.property('graphql.field.path', 'hello')
              expect(spans[5].meta).to.have.property('graphql.field.type', 'String')
              expect(spans[5].meta).to.have.property('graphql.field.source', 'hello(name: "world")')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument document parsing', done => {
          const source = `query MyQuery($who: String!) { hello(name: $who) }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              const query = spans[0]
              const parse = spans[1]
              expect(parse).to.have.property('service', 'test-graphql')
              expect(parse).to.have.property('name', 'graphql.parse')
              expect(parse.parent_id.toString()).to.equal(query.span_id.toString())
              expect(parse.start.toNumber()).to.be.gte(query.start.toNumber())
              expect(parse.duration.toNumber()).to.be.lte(query.duration.toNumber())
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument document validation', done => {
          const source = `query MyQuery($who: String!) { hello(name: $who) }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              const query = spans[0]
              const parse = spans[1]
              const validate = spans[2]
              expect(validate).to.have.property('service', 'test-graphql')
              expect(validate).to.have.property('name', 'graphql.validate')

              expect(validate.parent_id.toString()).to.equal(query.span_id.toString())
              expect(validate.start.toNumber()).to.be.gte(parse.start.toNumber() + parse.duration.toNumber())
              expect(validate.duration.toNumber()).to.be.lte(query.duration.toNumber())
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument query execution', done => {
          const source = `query MyQuery($who: String!) { hello(name: $who) }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              const query = spans[0]
              const validate = spans[2]
              const execute = spans[3]
              expect(execute).to.have.property('service', 'test-graphql')
              expect(execute).to.have.property('name', 'graphql.execute')

              expect(execute.parent_id.toString()).to.equal(query.span_id.toString())
              expect(execute.start.toNumber()).to.be.gte(validate.start.toNumber() + validate.duration.toNumber())
              expect(execute.duration.toNumber()).to.be.lte(query.duration.toNumber())
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
              expect(spans).to.have.length(14)

              const execute = spans[3]
              const humanField = spans[4]
              const humanResolve = spans[5]
              const humanNameField = spans[6]
              const humanNameResolve = spans[7]
              const addressField = spans[8]
              const addressResolve = spans[9]
              const addressCivicNumberField = spans[10]
              const addressCivicNumberResolve = spans[11]
              const addressStreetField = spans[12]
              const addressStreetResolve = spans[13]

              expect(execute).to.have.property('name', 'graphql.execute')

              expect(humanField).to.have.property('name', 'graphql.field')
              expect(humanField).to.have.property('resource', 'human')
              expect(humanField.meta).to.have.property('graphql.field.path', 'human')
              expect(humanField.parent_id.toString()).to.equal(execute.span_id.toString())
              expect(humanField.duration.toNumber()).to.be.lte(execute.duration.toNumber())

              expect(humanResolve).to.have.property('name', 'graphql.resolve')
              expect(humanResolve).to.have.property('resource', 'human')
              expect(humanResolve.meta).to.have.property('graphql.field.path', 'human')
              expect(humanResolve.parent_id.toString()).to.equal(humanField.span_id.toString())
              expect(humanResolve.duration.toNumber()).to.be.lte(humanField.duration.toNumber())

              expect(humanNameField).to.have.property('name', 'graphql.field')
              expect(humanNameField).to.have.property('resource', 'human.name')
              expect(humanNameField.meta).to.have.property('graphql.field.path', 'human.name')
              expect(humanNameField.parent_id.toString()).to.equal(humanField.span_id.toString())

              expect(humanNameResolve).to.have.property('name', 'graphql.resolve')
              expect(humanNameResolve).to.have.property('resource', 'human.name')
              expect(humanNameResolve.meta).to.have.property('graphql.field.path', 'human.name')
              expect(humanNameResolve.parent_id.toString()).to.equal(humanNameField.span_id.toString())

              expect(addressField).to.have.property('name', 'graphql.field')
              expect(addressField).to.have.property('resource', 'human.address')
              expect(addressField.meta).to.have.property('graphql.field.path', 'human.address')
              expect(addressField.parent_id.toString()).to.equal(humanField.span_id.toString())
              expect(addressField.duration.toNumber()).to.be.lte(humanField.duration.toNumber())

              expect(addressResolve).to.have.property('name', 'graphql.resolve')
              expect(addressResolve).to.have.property('resource', 'human.address')
              expect(addressResolve.meta).to.have.property('graphql.field.path', 'human.address')
              expect(addressResolve.parent_id.toString()).to.equal(addressField.span_id.toString())
              expect(addressResolve.duration.toNumber()).to.be.lte(addressField.duration.toNumber())

              expect(addressCivicNumberField).to.have.property('name', 'graphql.field')
              expect(addressCivicNumberField).to.have.property('resource', 'human.address.civicNumber')
              expect(addressCivicNumberField.meta).to.have.property('graphql.field.path', 'human.address.civicNumber')
              expect(addressCivicNumberField.parent_id.toString()).to.equal(addressField.span_id.toString())
              expect(addressCivicNumberField.duration.toNumber()).to.be.lte(addressField.duration.toNumber())

              expect(addressCivicNumberResolve).to.have.property('name', 'graphql.resolve')
              expect(addressCivicNumberResolve).to.have.property('resource', 'human.address.civicNumber')
              expect(addressCivicNumberResolve.meta).to.have.property('graphql.field.path', 'human.address.civicNumber')
              expect(addressCivicNumberResolve.parent_id.toString())
                .to.equal(addressCivicNumberField.span_id.toString())
              expect(addressCivicNumberResolve.duration.toNumber())
                .to.be.lte(addressCivicNumberField.duration.toNumber())

              expect(addressStreetField).to.have.property('name', 'graphql.field')
              expect(addressStreetField).to.have.property('resource', 'human.address.street')
              expect(addressStreetField.meta).to.have.property('graphql.field.path', 'human.address.street')
              expect(addressStreetField.parent_id.toString()).to.equal(addressField.span_id.toString())
              expect(addressStreetField.duration.toNumber()).to.be.lte(addressField.duration.toNumber())

              expect(addressStreetResolve).to.have.property('name', 'graphql.resolve')
              expect(addressStreetResolve).to.have.property('resource', 'human.address.street')
              expect(addressStreetResolve.meta).to.have.property('graphql.field.path', 'human.address.street')
              expect(addressStreetResolve.parent_id.toString()).to.equal(addressStreetField.span_id.toString())
              expect(addressStreetResolve.duration.toNumber()).to.be.lte(addressStreetField.duration.toNumber())
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
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

              expect(spans).to.have.length(12)

              const execute = spans[3]
              const friendsField = spans[4]
              const friendsResolve = spans[5]
              const friendNameField = spans[6]
              const friendNameResolve = spans[7]
              const petsField = spans[8]
              const petsResolve = spans[9]
              const petsNameField = spans[10]
              const petsNameResolve = spans[11]

              expect(execute).to.have.property('name', 'graphql.execute')

              expect(friendsField).to.have.property('name', 'graphql.field')
              expect(friendsField).to.have.property('resource', 'friends')
              expect(friendsField.meta).to.have.property('graphql.field.path', 'friends')
              expect(friendsField.parent_id.toString()).to.equal(execute.span_id.toString())

              expect(friendsResolve).to.have.property('name', 'graphql.resolve')
              expect(friendsResolve).to.have.property('resource', 'friends')
              expect(friendsResolve.meta).to.have.property('graphql.field.path', 'friends')
              expect(friendsResolve.parent_id.toString()).to.equal(friendsField.span_id.toString())

              expect(friendNameField).to.have.property('name', 'graphql.field')
              expect(friendNameField).to.have.property('resource', 'friends.*.name')
              expect(friendNameField.meta).to.have.property('graphql.field.path', 'friends.*.name')
              expect(friendNameField.parent_id.toString()).to.equal(friendsField.span_id.toString())

              expect(friendNameResolve).to.have.property('name', 'graphql.resolve')
              expect(friendNameResolve).to.have.property('resource', 'friends.*.name')
              expect(friendNameResolve.meta).to.have.property('graphql.field.path', 'friends.*.name')
              expect(friendNameResolve.parent_id.toString()).to.equal(friendNameField.span_id.toString())

              expect(petsField).to.have.property('name', 'graphql.field')
              expect(petsField).to.have.property('resource', 'friends.*.pets')
              expect(petsField.meta).to.have.property('graphql.field.path', 'friends.*.pets')
              expect(petsField.parent_id.toString()).to.equal(friendsField.span_id.toString())

              expect(petsResolve).to.have.property('name', 'graphql.resolve')
              expect(petsResolve).to.have.property('resource', 'friends.*.pets')
              expect(petsResolve.meta).to.have.property('graphql.field.path', 'friends.*.pets')
              expect(petsResolve.parent_id.toString()).to.equal(petsField.span_id.toString())

              expect(petsNameField).to.have.property('name', 'graphql.field')
              expect(petsNameField).to.have.property('resource', 'friends.*.pets.*.name')
              expect(petsNameField.meta).to.have.property('graphql.field.path', 'friends.*.pets.*.name')
              expect(petsNameField.parent_id.toString()).to.equal(petsField.span_id.toString())

              expect(petsNameResolve).to.have.property('name', 'graphql.resolve')
              expect(petsNameResolve).to.have.property('resource', 'friends.*.pets.*.name')
              expect(petsNameResolve.meta).to.have.property('graphql.field.path', 'friends.*.pets.*.name')
              expect(petsNameResolve.parent_id.toString()).to.equal(petsNameField.span_id.toString())
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

              expect(spans).to.have.length(8)
              expect(spans[0]).to.have.property('name', 'graphql.mutation')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should instrument subscriptions', done => {
          const source = `subscription { human { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(6)
              expect(spans[0]).to.have.property('name', 'graphql.subscription')
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
            })
            .then(done)
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

              expect(spans).to.have.length(4)
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

              expect(spans).to.have.length(4)
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

                expect(spans).to.have.length(6)
              })
              .then(done)
              .catch(done)

            graphql.graphql(schema, source).catch(done)
          })

          graphql.graphql(schema, source).catch(done)
        })

        it('should run rootValue resolvers in the current context', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

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

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(6)
              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[1]).to.have.property('name', 'graphql.parse')
              expect(spans[2]).to.have.property('name', 'graphql.validate')
              expect(spans[3]).to.have.property('name', 'graphql.execute')
              expect(spans[4]).to.have.property('name', 'graphql.field')
              expect(spans[5]).to.have.property('name', 'graphql.resolve')
            })
            .then(done)
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

              expect(spans).to.have.length(5)
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
          const source = `{ hello }`
          const document = graphql.parse(source)

          let error

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(3)
              expect(spans[2]).to.have.property('service', 'test-graphql')
              expect(spans[2]).to.have.property('name', 'graphql.execute')
              expect(spans[2]).to.have.property('error', 1)
              expect(spans[2].meta).to.have.property('error.type', error.name)
              expect(spans[2].meta).to.have.property('error.msg', error.message)
              expect(spans[2].meta).to.have.property('error.stack', error.stack)
            })
            .then(done)
            .catch(done)

          try {
            graphql.execute({}, document)
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

              expect(spans).to.have.length(6)
              expect(spans[5]).to.have.property('error', 1)
              expect(spans[5].meta).to.have.property('error.type', error.name)
              expect(spans[5].meta).to.have.property('error.msg', error.message)
              expect(spans[5].meta).to.have.property('error.stack', error.stack)
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

              expect(spans).to.have.length(6)
              expect(spans[5]).to.have.property('error', 1)
              expect(spans[5].meta).to.have.property('error.type', error.name)
              expect(spans[5].meta).to.have.property('error.msg', error.message)
              expect(spans[5].meta).to.have.property('error.stack', error.stack)
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
        before(() => {
          tracer = require('../..')

          return agent.load(plugin, 'graphql', {
            service: 'test',
            variables: variables => Object.assign({}, variables, { who: 'REDACTED' })
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should be configured with the correct values', done => {
          const source = `{ hello(name: "world") }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(6)
              expect(spans[2]).to.have.property('service', 'test')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should apply the filter callback to the variables', done => {
          const source = `
            query MyQuery($title: String!, $who: String!) {
              hello(title: $title, name: $who)
            }
          `

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].meta).to.have.property('graphql.variables.title', 'planet')
              expect(spans[0].meta).to.have.property('graphql.variables.who', 'REDACTED')
              expect(spans[4].meta).to.have.property('graphql.variables.title', 'planet')
              expect(spans[4].meta).to.have.property('graphql.variables.who', 'REDACTED')
              expect(spans[5].meta).to.have.property('graphql.variables.title', 'planet')
              expect(spans[5].meta).to.have.property('graphql.variables.who', 'REDACTED')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source, null, null, { title: 'planet', who: 'world' }).catch(done)
        })
      })

      describe('with an array of variable names', () => {
        before(() => {
          tracer = require('../..')

          return agent.load(plugin, 'graphql', {
            variables: ['title']
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should only include the configured variables', done => {
          const source = `
            query MyQuery($title: String!, $who: String!) {
              hello(title: $title, name: $who)
            }
          `

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].meta).to.have.property('graphql.variables.title', 'planet')
              expect(spans[0].meta).to.not.have.property('graphql.variables.who')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source, null, null, { title: 'planet', who: 'world' }).catch(done)
        })
      })

      describe('with a depth of 0', () => {
        before(() => {
          tracer = require('../..')

          return agent.load(plugin, 'graphql', { depth: 0 })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should only instrument the operation', done => {
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

              expect(spans).to.have.length(4)
              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[1]).to.have.property('name', 'graphql.parse')
              expect(spans[2]).to.have.property('name', 'graphql.validate')
              expect(spans[3]).to.have.property('name', 'graphql.execute')
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })

        it('should run the resolvers in the execution scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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
          tracer = require('../..')

          return agent.load(plugin, 'graphql', { depth: 2 })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../versions/graphql@${version}`).get()
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
                  'human.address.civicNumber',
                  'human.address.street'
                ].indexOf(span.resource) !== -1
              })

              expect(spans).to.have.length(12)
              expect(ignored).to.have.length(0)
            })
            .then(done)
            .catch(done)

          graphql.graphql(schema, source).catch(done)
        })
      })

      describe('with collapsing disabled', () => {
        before(() => {
          tracer = require('../..')

          return agent.load(plugin, 'graphql', { collapse: false })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          graphql = require(`../../versions/graphql@${version}`).get()
          buildSchema()
        })

        it('should not collapse list field resolvers', done => {
          const source = `{ friends { name } }`

          agent
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(10)

              const execute = spans[3]
              const friendsField = spans[4]
              const friendsResolve = spans[5]
              const friend0NameField = spans[6]
              const friend0NameResolve = spans[7]
              const friend1NameField = spans[8]
              const friend1NameResolve = spans[9]

              expect(execute).to.have.property('name', 'graphql.execute')

              expect(friendsField).to.have.property('name', 'graphql.field')
              expect(friendsField).to.have.property('resource', 'friends')
              expect(friendsField.parent_id.toString()).to.equal(execute.span_id.toString())

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
      })

      withVersions(plugin, 'apollo-server-core', apolloVersion => {
        let runQuery
        let mergeSchemas
        let makeExecutableSchema

        before(() => {
          tracer = require('../..')

          return agent.load(plugin, 'graphql')
            .then(() => {
              graphql = require(`../../versions/graphql@${version}`).get()

              const apolloCore = require(`../../versions/apollo-server-core@${apolloVersion}`).get()
              const graphqlTools = require(`../../versions/graphql-tools@3.1.1`).get()

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
            .use(traces => {
              const spans = sort(traces[0])

              expect(spans).to.have.length(11)

              expect(spans[0]).to.have.property('name', 'graphql.query')
              expect(spans[0]).to.have.property('resource', 'query MyQuery')
              expect(spans[0].meta).to.have.property('graphql.document')

              expect(spans[1]).to.have.property('name', 'graphql.parse')

              expect(spans[2]).to.have.property('name', 'graphql.validate')

              expect(spans[3]).to.have.property('name', 'graphql.execute')

              expect(spans[4]).to.have.property('name', 'graphql.field')
              expect(spans[4]).to.have.property('resource', 'hello')

              expect(spans[5]).to.have.property('name', 'graphql.resolve')
              expect(spans[5]).to.have.property('resource', 'hello')

              expect(spans[6]).to.have.property('name', 'graphql.query')
              expect(spans[6]).to.have.property('resource', 'query MyQuery')
              expect(spans[6].meta).to.not.have.property('graphql.document')

              expect(spans[7]).to.have.property('name', 'graphql.validate')

              expect(spans[8]).to.have.property('name', 'graphql.execute')

              expect(spans[9]).to.have.property('name', 'graphql.field')
              expect(spans[9]).to.have.property('resource', 'hello')

              expect(spans[10]).to.have.property('name', 'graphql.resolve')
              expect(spans[10]).to.have.property('resource', 'hello')
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
