'use strict'

const agent = require('./agent')

wrapIt()

describe('Plugin', () => {
  let plugin
  let context
  let graphql
  let schema
  let sort

  function buildSchema () {
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
            type: new graphql.GraphQLObjectType({
              name: 'Human',
              fields: {
                name: {
                  type: graphql.GraphQLString,
                  resolve (obj, args) {
                    return obj
                  }
                }
              }
            }),
            resolve (obj, args) {
              return Promise.resolve('test')
            }
          }
        }
      })
    })
  }

  describe('graphql', () => {
    beforeEach(() => {
      plugin = require('../../src/plugins/graphql')
      context = require('../../src/platform').context()

      sort = spans => spans.sort((a, b) => a.start.toString() > b.start.toString() ? 1 : -1)
    })

    afterEach(() => {
      agent.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load(plugin, 'graphql')
          .then(() => {
            graphql = require('graphql')
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
        const source = `{ human { name } }`

        agent
          .use(traces => {
            const spans = sort(traces[0])

            expect(spans).to.have.length(5)

            const query = spans[0]
            const humanField = spans[1]
            const humanResolve = spans[2]
            const humanNameField = spans[3]
            const humanNameResolve = spans[4]

            expect(query).to.have.property('name', 'graphql.query')
            expect(query).to.have.property('resource', 'query')

            expect(humanField).to.have.property('name', 'graphql.field')
            expect(humanField).to.have.property('resource', 'human')
            expect(humanField.parent_id.toString()).to.equal(query.span_id.toString())

            expect(humanResolve).to.have.property('name', 'graphql.resolve')
            expect(humanResolve).to.have.property('resource', 'human')
            expect(humanResolve.parent_id.toString()).to.equal(humanField.span_id.toString())

            expect(humanNameField).to.have.property('name', 'graphql.field')
            expect(humanNameField).to.have.property('resource', 'human.name')
            expect(humanNameField.parent_id.toString()).to.equal(humanField.span_id.toString())

            expect(humanNameResolve).to.have.property('name', 'graphql.resolve')
            expect(humanNameResolve).to.have.property('resource', 'human.name')
            expect(humanNameResolve.parent_id.toString()).to.equal(humanNameField.span_id.toString())
          })
          .then(done)
          .catch(done)

        graphql.graphql(schema, source).catch(done)
      })

      it('should instrument the default field resolver', done => {
        const schema = graphql.buildSchema(`
          type Query {
            hello: String
          }
        `)

        const source = `{ hello }`

        agent
          .use(traces => {
            const spans = sort(traces[0])

            expect(spans).to.have.length(3)
            expect(spans[2]).to.have.property('resource', 'hello')
          })
          .then(done)
          .catch(done)

        graphql.graphql(schema, source, { hello: 'world' }).catch(done)
      })

      it('should instrument a custom field resolver', done => {
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

            expect(spans).to.have.length(3)
            expect(spans[2]).to.have.property('resource', 'hello')
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

      it('should run the field resolver in the trace context', done => {
        const schema = graphql.buildSchema(`
          type Query {
            hello: String
          }
        `)

        const source = `{ hello }`

        const rootValue = { hello: 'world' }

        const fieldResolver = (source, args, contextValue, info) => {
          expect(context.get('current')).to.not.be.undefined
          done()
          return source[info.fieldName]
        }

        graphql.graphql({ schema, source, rootValue, fieldResolver }).catch(done)
      })

      it('should run resolvers in the current context', done => {
        const schema = graphql.buildSchema(`
          type Query {
            hello: String
          }
        `)

        const source = `{ hello }`

        const rootValue = {
          hello () {
            expect(context.get('current')).to.not.be.undefined
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

        return graphql.graphql({ schema, source, rootValue })
          .then(value => {
            expect(value).to.have.nested.property('data.hello', 'test')
            expect(context.get('current')).to.be.undefined
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

        graphql.execute(schema, document)
      })

      it('should handle exceptions', done => {
        const error = new Error('test')

        const schema = graphql.buildSchema(`
          type Query {
            hello: String
          }
        `)

        const source = `{ hello }`

        const fieldResolver = (source, args, contextValue, info) => {
          throw error
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

        graphql.graphql({ schema, source, fieldResolver }).catch(done)
      })

      it('should handle rejected promises', done => {
        const error = new Error('test')

        const schema = graphql.buildSchema(`
          type Query {
            hello: String
          }
        `)

        const source = `{ hello }`

        const fieldResolver = (source, args, contextValue, info) => {
          return Promise.reject(error)
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

        graphql.graphql({ schema, source, fieldResolver }).catch(done)
      })
    })

    describe('with configuration', () => {
      beforeEach(() => {
        return agent.load(plugin, 'graphql', { service: 'test' })
          .then(() => {
            graphql = require('graphql')
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
