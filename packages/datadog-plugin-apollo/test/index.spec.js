'use strict'

const { expect } = require('chai')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent.js')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants.js')
const { expectedSchema, rawExpectedSchema } = require('./naming.js')
const axios = require('axios')

const accounts = require('./fixtures.js')

const graphqlTag = require('../../../versions/graphql-tag/index.js').get()
const gql = graphqlTag.gql
accounts.typeDefs = gql(accounts.typeDefs)

const fixtures = [accounts]

async function execute (executor, source, variables, operationName) {
  const resp = await executor({
    source,
    document: gql(source),
    request: {
      variables
    },
    operationName,
    queryHash: 'hashed',
    context: null,
    cache: {}
  })
  return resp
}

describe('Plugin', () => {
  let ApolloGateway
  let LocalGraphQLDataSource
  let buildSubgraphSchema
  let ApolloServer
  let startStandaloneServer

  function setupGateway () {
    const localDataSources = Object.fromEntries(
      fixtures.map((f) => [
        f.name,
        new LocalGraphQLDataSource(buildSubgraphSchema(f))
      ])
    )

    const gateway = new ApolloGateway({
      localServiceList: fixtures,
      buildService (service) {
        return localDataSources[service.name]
      }
    })
    return gateway
  }

  function gateway () {
    return setupGateway().load().then((res) => res)
  }

  describe('@apollo/gateway', () => {
    withVersions('apollo', '@apollo/gateway', version => {
      before(() => {
        require('../../dd-trace/index.js')
        const apollo = require(`../../../versions/@apollo/gateway@${version}`).get()
        const subgraph = require('../../../versions/@apollo/subgraph').get()
        buildSubgraphSchema = subgraph.buildSubgraphSchema
        ApolloGateway = apollo.ApolloGateway
        LocalGraphQLDataSource = apollo.LocalGraphQLDataSource
      })
      after(() => {
        return agent.close({ ritmReset: false })
      })

      describe('@apollo/server', () => {
        let server
        let port

        before(() => {
          ApolloServer = require('../../../versions/@apollo/server/index.js').get().ApolloServer
          startStandaloneServer =
            require('../../../versions/@apollo/server@4.0.0/node_modules/@apollo/server/dist/cjs/standalone/index.js')
              .startStandaloneServer

          server = new ApolloServer({
            gateway: setupGateway(),
            subscriptions: false // Disable subscriptions (not supported with Apollo Gateway)
          })

          return startStandaloneServer(server, {
            listen: { port: 0 }
          }).then(({ url }) => {
            port = new URL(url).port
          })
        })

        before(() => {
          return agent.load('apollo')
        })

        after(() => {
          server.stop()
        })

        it('should instrument apollo/gateway when using apollo server', done => {
          const query = `
            query ExampleQuery {
              human {
                name
              }
              friends {
                name
              }
            }`
          agent
            .assertSomeTraces((traces) => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][1]).to.have.property('name', 'apollo.gateway.validate')
              expect(traces[0][2]).to.have.property('name', 'apollo.gateway.plan')
              expect(traces[0][3]).to.have.property('name', 'apollo.gateway.execute')
              expect(traces[0][4]).to.have.property('name', 'apollo.gateway.fetch')
              expect(traces[0][5]).to.have.property('name', 'apollo.gateway.postprocessing')
            })
            .then(done)
            .catch(done)

          axios.post(`http://localhost:${port}/`, {
            query
          })
        })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('apollo')
        })

        it('should instrument apollo/gateway', done => {
          const operationName = 'MyQuery'
          const source = `query ${operationName} { hello(name: "world") }`
          const variableValues = { who: 'world' }
          agent
            .assertSomeTraces((traces) => {
              // the spans are in order of execution
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'query MyQuery{hello(name:"")}')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('graphql.operation.name', operationName)
              expect(traces[0][0].meta).to.not.have.property('graphql.source')
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'query')
              expect(traces[0][0].meta).to.have.property('component', 'apollo.gateway')

              expect(traces[0][1]).to.have.property('name', 'apollo.gateway.validate')
              expect(traces[0][1]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][1]).to.have.property('type', 'web')
              expect(traces[0][1]).to.have.property('error', 0)
              expect(traces[0][1].meta).to.have.property('component', 'apollo.gateway')

              expect(traces[0][2]).to.have.property('name', 'apollo.gateway.plan')
              expect(traces[0][2]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][2]).to.have.property('type', 'web')
              expect(traces[0][2]).to.have.property('error', 0)
              expect(traces[0][2].meta).to.have.property('component', 'apollo.gateway')

              expect(traces[0][3]).to.have.property('name', 'apollo.gateway.execute')
              expect(traces[0][3]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][3]).to.have.property('type', 'web')
              expect(traces[0][3]).to.have.property('error', 0)
              expect(traces[0][3].meta).to.have.property('component', 'apollo.gateway')

              expect(traces[0][4]).to.have.property('name', 'apollo.gateway.fetch')
              expect(traces[0][4]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][4]).to.have.property('type', 'web')
              expect(traces[0][4]).to.have.property('error', 0)
              expect(traces[0][4].meta).to.have.property('serviceName', 'accounts')
              expect(traces[0][4].meta).to.have.property('component', 'apollo.gateway')

              expect(traces[0][5]).to.have.property('name', 'apollo.gateway.postprocessing')
              expect(traces[0][5]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][5]).to.have.property('type', 'web')
              expect(traces[0][5]).to.have.property('error', 0)
              expect(traces[0][5].meta).to.have.property('component', 'apollo.gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(({ executor }) => {
              return execute(executor, source, variableValues, operationName).then(() => {})
            })
        })

        it('should instrument schema resolver', done => {
          const source = '{ hello(name: "world") }'
          agent
            .assertSomeTraces((traces) => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('resource', '{hello(name:"")}')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.not.have.property('graphql.source')
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'query')
              expect(traces[0][0].meta).to.have.property('component', 'apollo.gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(({ executor }) => {
              return execute(executor, source).then(() => {})
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
            .assertSomeTraces((traces) => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('resource', '{human{address{civicNumber street}name}}')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.not.have.property('graphql.source')
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'query')
              expect(traces[0][0].meta).to.have.property('component', 'apollo.gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(({ executor }) => {
              return execute(executor, source).then(() => {})
            })
        })

        it('should instrument mutations', done => {
          const source = 'mutation { human { name } }'

          agent
            .assertSomeTraces((traces) => {
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'mutation')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(({ executor }) => {
              return execute(executor, source).then(() => {})
            })
        })

        it('should handle a circular schema', done => {
          const source = '{ human { pets { owner { name } } } }'

          gateway()
            .then(({ executor }) => {
              return execute(executor, source).then((result) => {
                expect(result.data.human.pets[0].owner.name).to.equal('test')
              })
                .then(done)
                .catch(done)
            })
        })

        it('should instrument validation failure', done => {
          let error
          const source = `#graphql
            query InvalidVariables($first: Int!, $second: Int!) {
              topReviews(first: $first) {
                body
              }
            }`
          const variableValues = { who: 'world' }
          agent
            .assertSomeTraces((traces) => {
              expect(traces[0].length).equal(2)
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'apollo.gateway')

              expect(traces[0][1]).to.have.property('name', 'apollo.gateway.validate')
              expect(traces[0][1]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][1]).to.have.property('error', 1)
              expect(traces[0][1].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][1].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][1].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][1].meta).to.have.property('component', 'apollo.gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(({ executor }) => {
              return execute(executor, source, variableValues, 'InvalidVariables').then((result) => {
                error = result.errors[1]
              })
            })
        })

        it('should instrument plan failure', done => {
          let error
          const operationName = 'MyQuery'
          const source = `subscription ${operationName} { hello(name: "world") }`
          const variableValues = { who: 'world' }
          agent
            .assertSomeTraces((traces) => {
              expect(traces[0].length).equal(3)
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('error', 1)

              expect(traces[0][1]).to.have.property('name', 'apollo.gateway.validate')
              expect(traces[0][1]).to.have.property('error', 0)

              expect(traces[0][2]).to.have.property('name', 'apollo.gateway.plan')
              expect(traces[0][2]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][2]).to.have.property('error', 1)
              expect(traces[0][2].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][2].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][2].meta).to.have.property(ERROR_STACK, error.stack)
            })
            .then(done)
            .catch(done)

          gateway()
            .then(({ executor }) => {
              return execute(executor, source, variableValues, operationName)
                .then(() => {})
                .catch((e) => {
                  error = e
                })
            })
        })

        it('should instrument fetch failure', done => {
          let error
          const operationName = 'MyQuery'
          const source = `query ${operationName} { hello(name: "world") }`
          const variableValues = { who: 'world' }
          agent
            .assertSomeTraces((traces) => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)

              expect(traces[0][1]).to.have.property('name', 'apollo.gateway.validate')
              expect(traces[0][1]).to.have.property('error', 0)

              expect(traces[0][2]).to.have.property('name', 'apollo.gateway.plan')
              expect(traces[0][2]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][2]).to.have.property('error', 0)

              expect(traces[0][3]).to.have.property('name', 'apollo.gateway.execute')
              // In order to mimick the ApolloGateway instrumentation we also patch
              // the call to  the recordExceptions() method by ApolloGateway
              // in version 2.3.0, there is no recordExceptions method thus we can't ever attach an error to the
              // fetch span but instead the error will be propagated to the request span and be set there
              if (version > '2.3.0') {
                expect(traces[0][3]).to.have.property('error', 1)
                expect(traces[0][3].meta).to.have.property(ERROR_TYPE, error.name)
                expect(traces[0][3].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(traces[0][3].meta).to.have.property(ERROR_STACK, error.stack)
              } else { expect(traces[0][3]).to.have.property('error', 0) }

              expect(traces[0][4]).to.have.property('name', 'apollo.gateway.fetch')
              expect(traces[0][4]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][4]).to.have.property('error', 1)
              expect(traces[0][4].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][4].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][4].meta).to.have.property(ERROR_STACK, error.stack)

              expect(traces[0][5]).to.have.property('name', 'apollo.gateway.postprocessing')
              expect(traces[0][5]).to.have.property('error', 0)
            })
            .then(done)
            .catch(done)

          const gateway = new ApolloGateway({
            localServiceList: fixtures,
            fetcher: () => {
              throw Error('Nooo')
            }
          })
          gateway.load().then(resp => {
            return execute(resp.executor, source, variableValues, operationName)
              .then((result) => {
                const errors = result.errors
                error = errors[errors.length - 1]
              })
          })
        })

        it('should run spans in the correct context', done => {
          const operationName = 'MyQuery'
          const source = `query ${operationName} { hello(name: "world") }`
          const variableValues = { who: 'world' }

          agent
            .assertSomeTraces((traces) => {
              // the spans are in order of execution
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)

              expect(traces[0][1]).to.have.property('name', 'apollo.gateway.validate')
              expect(traces[0][1].parent_id.toString()).to.equal(traces[0][0].span_id.toString())

              expect(traces[0][2]).to.have.property('name', 'apollo.gateway.plan')
              expect(traces[0][2].parent_id.toString()).to.equal(traces[0][0].span_id.toString())

              expect(traces[0][3]).to.have.property('name', 'apollo.gateway.execute')
              expect(traces[0][3].parent_id.toString()).to.equal(traces[0][0].span_id.toString())

              expect(traces[0][4]).to.have.property('name', 'apollo.gateway.fetch')
              expect(traces[0][4].parent_id.toString()).to.equal(traces[0][3].span_id.toString())

              expect(traces[0][5]).to.have.property('name', 'apollo.gateway.postprocessing')
              expect(traces[0][5].parent_id.toString()).to.equal(traces[0][3].span_id.toString())
            })
            .then(done)
            .catch(done)

          gateway()
            .then(({ executor }) => {
              return execute(executor, source, variableValues, operationName).then(() => {})
            })
        })

        withNamingSchema(
          async () => {
            const operationName = 'MyQuery'
            const source = `query ${operationName} { hello(name: "world") }`
            const variableValues = { who: 'world' }
            const { executor } = await gateway()
            return execute(executor, source, variableValues, operationName)
          },
          rawExpectedSchema.server,
          {
            selectSpan: (traces) => {
              return traces[0][0]
            }
          }
        )

        describe('with configuration', () => {
          before(() => {
            return agent.load('apollo', { service: 'custom', source: true, signature: false })
          })

          it('should be configured with the correct values', done => {
            const operationName = 'MyQuery'
            const source = `query ${operationName} { hello(name: "world") }`
            const variableValues = { who: 'world' }
            agent
              .assertSomeTraces((traces) => {
                expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
                expect(traces[0][0]).to.have.property('service', 'custom')
                expect(traces[0][0]).to.have.property('resource', `query ${operationName}`)
                expect(traces[0][0].meta).to.have.property('graphql.source', source)

                expect(traces[0][1]).to.have.property('name', 'apollo.gateway.validate')
                expect(traces[0][1]).to.have.property('service', 'custom')

                expect(traces[0][2]).to.have.property('name', 'apollo.gateway.plan')
                expect(traces[0][2]).to.have.property('service', 'custom')

                expect(traces[0][3]).to.have.property('name', 'apollo.gateway.execute')
                expect(traces[0][3]).to.have.property('service', 'custom')

                expect(traces[0][4]).to.have.property('name', 'apollo.gateway.fetch')
                expect(traces[0][4]).to.have.property('service', 'custom')

                expect(traces[0][5]).to.have.property('name', 'apollo.gateway.postprocessing')
                expect(traces[0][5]).to.have.property('service', 'custom')
              })
              .then(done)
              .catch(done)

            gateway()
              .then(({ executor }) => {
                return execute(executor, source, variableValues, operationName).then(() => {})
              })
          })
        })
      })
    })
  })
})
