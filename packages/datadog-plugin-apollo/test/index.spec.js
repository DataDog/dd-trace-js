'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants.js')
const agent = require('../../dd-trace/test/plugins/agent.js')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const accounts = require('./fixtures.js')
const { expectedSchema, rawExpectedSchema } = require('./naming.js')

const fixtures = [accounts]
const typeDefs = accounts.typeDefs

describe('Plugin', () => {
  let ApolloGateway
  let LocalGraphQLDataSource
  let buildSubgraphSchema
  let ApolloServer
  let startStandaloneServer
  let gql

  function setupFixtures () {
    const graphqlTag = require('../../../versions/graphql-tag/index.js').get()
    gql = graphqlTag.gql
    accounts.typeDefs = gql(typeDefs)
  }

  function setupApollo (version) {
    require('../../dd-trace/index.js')
    const apollo = require(`../../../versions/@apollo/gateway@${version}`).get()
    const subgraph = require('../../../versions/@apollo/subgraph').get()
    buildSubgraphSchema = subgraph.buildSubgraphSchema
    ApolloGateway = apollo.ApolloGateway
    LocalGraphQLDataSource = apollo.LocalGraphQLDataSource
  }

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

  function gateway () {
    return setupGateway().load().then((res) => res)
  }

  describe('@apollo/gateway', () => {
    withVersions('apollo', '@apollo/gateway', version => {
      after(() => {
        return agent.close({ ritmReset: false })
      })

      describe('@apollo/server', () => {
        let server
        let port

        before(() => agent.load('apollo'))
        before(() => setupFixtures())
        before(() => setupApollo(version))

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
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
              assert.strictEqual(traces[0][1].name, 'apollo.gateway.validate')
              assert.strictEqual(traces[0][2].name, 'apollo.gateway.plan')
              assert.strictEqual(traces[0][3].name, 'apollo.gateway.execute')
              assert.strictEqual(traces[0][4].name, 'apollo.gateway.fetch')
              assert.strictEqual(traces[0][5].name, 'apollo.gateway.postprocessing')
            })
            .then(done)
            .catch(done)

          axios.post(`http://localhost:${port}/`, {
            query
          })
        })
      })

      describe('without configuration', () => {
        before(() => agent.load('apollo'))
        before(() => setupFixtures())
        before(() => setupApollo(version))

        it('should instrument apollo/gateway', done => {
          const operationName = 'MyQuery'
          const source = `query ${operationName} { hello(name: "world") }`
          const variableValues = { who: 'world' }
          agent
            .assertSomeTraces((traces) => {
              // the spans are in order of execution
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][0].resource, 'query MyQuery{hello(name:"")}')
              assert.strictEqual(traces[0][0].type, 'web')
              assert.strictEqual(traces[0][0].error, 0)
              assert.strictEqual(traces[0][0].meta['graphql.operation.name'], operationName)
              assert.ok(!('graphql.source' in traces[0][0].meta))
              assert.strictEqual(traces[0][0].meta['graphql.operation.type'], 'query')
              assert.strictEqual(traces[0][0].meta.component, 'apollo.gateway')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'apollo.gateway')

              assert.strictEqual(traces[0][1].name, 'apollo.gateway.validate')
              assert.strictEqual(traces[0][1].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][1].type, 'web')
              assert.strictEqual(traces[0][1].error, 0)
              assert.strictEqual(traces[0][1].meta.component, 'apollo.gateway')

              assert.strictEqual(traces[0][2].name, 'apollo.gateway.plan')
              assert.strictEqual(traces[0][2].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][2].type, 'web')
              assert.strictEqual(traces[0][2].error, 0)
              assert.strictEqual(traces[0][2].meta.component, 'apollo.gateway')

              assert.strictEqual(traces[0][3].name, 'apollo.gateway.execute')
              assert.strictEqual(traces[0][3].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][3].type, 'web')
              assert.strictEqual(traces[0][3].error, 0)
              assert.strictEqual(traces[0][3].meta.component, 'apollo.gateway')

              assert.strictEqual(traces[0][4].name, 'apollo.gateway.fetch')
              assert.strictEqual(traces[0][4].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][4].type, 'web')
              assert.strictEqual(traces[0][4].error, 0)
              assert.strictEqual(traces[0][4].meta.serviceName, 'accounts')
              assert.strictEqual(traces[0][4].meta.component, 'apollo.gateway')

              assert.strictEqual(traces[0][5].name, 'apollo.gateway.postprocessing')
              assert.strictEqual(traces[0][5].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][5].type, 'web')
              assert.strictEqual(traces[0][5].error, 0)
              assert.strictEqual(traces[0][5].meta.component, 'apollo.gateway')
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
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][0].resource, '{hello(name:"")}')
              assert.strictEqual(traces[0][0].type, 'web')
              assert.strictEqual(traces[0][0].error, 0)
              assert.ok(!('graphql.source' in traces[0][0].meta))
              assert.strictEqual(traces[0][0].meta['graphql.operation.type'], 'query')
              assert.strictEqual(traces[0][0].meta.component, 'apollo.gateway')
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
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][0].resource, '{human{address{civicNumber street}name}}')
              assert.strictEqual(traces[0][0].type, 'web')
              assert.strictEqual(traces[0][0].error, 0)
              assert.ok(!('graphql.source' in traces[0][0].meta))
              assert.strictEqual(traces[0][0].meta['graphql.operation.type'], 'query')
              assert.strictEqual(traces[0][0].meta.component, 'apollo.gateway')
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
              assert.strictEqual(traces[0][0].meta['graphql.operation.type'], 'mutation')
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
                assert.strictEqual(result.data.human.pets[0].owner.name, 'test')
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
              assert.strictEqual(traces[0].length, 2)
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
              assert.strictEqual(traces[0][0].meta.component, 'apollo.gateway')

              assert.strictEqual(traces[0][1].name, 'apollo.gateway.validate')
              assert.strictEqual(traces[0][1].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][1].error, 1)
              assert.strictEqual(traces[0][1].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][1].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][1].meta[ERROR_STACK], error.stack)
              assert.strictEqual(traces[0][1].meta.component, 'apollo.gateway')
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
              assert.strictEqual(traces[0].length, 3)
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][0].error, 1)

              assert.strictEqual(traces[0][1].name, 'apollo.gateway.validate')
              assert.strictEqual(traces[0][1].error, 0)

              assert.strictEqual(traces[0][2].name, 'apollo.gateway.plan')
              assert.strictEqual(traces[0][2].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][2].error, 1)
              assert.strictEqual(traces[0][2].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][2].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][2].meta[ERROR_STACK], error.stack)
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
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)

              assert.strictEqual(traces[0][1].name, 'apollo.gateway.validate')
              assert.strictEqual(traces[0][1].error, 0)

              assert.strictEqual(traces[0][2].name, 'apollo.gateway.plan')
              assert.strictEqual(traces[0][2].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][2].error, 0)

              assert.strictEqual(traces[0][3].name, 'apollo.gateway.execute')
              // In order to mimick the ApolloGateway instrumentation we also patch
              // the call to  the recordExceptions() method by ApolloGateway
              // in version 2.3.0, there is no recordExceptions method thus we can't ever attach an error to the
              // fetch span but instead the error will be propagated to the request span and be set there
              if (version > '2.3.0') {
                assert.strictEqual(traces[0][3].error, 1)
                assert.strictEqual(traces[0][3].meta[ERROR_TYPE], error.name)
                assert.strictEqual(traces[0][3].meta[ERROR_MESSAGE], error.message)
                assert.strictEqual(traces[0][3].meta[ERROR_STACK], error.stack)
              } else { assert.strictEqual(traces[0][3].error, 0) }

              assert.strictEqual(traces[0][4].name, 'apollo.gateway.fetch')
              assert.strictEqual(traces[0][4].service, expectedSchema.server.serviceName)
              assert.strictEqual(traces[0][4].error, 1)
              assert.strictEqual(traces[0][4].meta[ERROR_TYPE], error.name)
              assert.strictEqual(traces[0][4].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(traces[0][4].meta[ERROR_STACK], error.stack)

              assert.strictEqual(traces[0][5].name, 'apollo.gateway.postprocessing')
              assert.strictEqual(traces[0][5].error, 0)
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
              assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)

              assert.strictEqual(traces[0][1].name, 'apollo.gateway.validate')
              assert.strictEqual(traces[0][1].parent_id.toString(), traces[0][0].span_id.toString())

              assert.strictEqual(traces[0][2].name, 'apollo.gateway.plan')
              assert.strictEqual(traces[0][2].parent_id.toString(), traces[0][0].span_id.toString())

              assert.strictEqual(traces[0][3].name, 'apollo.gateway.execute')
              assert.strictEqual(traces[0][3].parent_id.toString(), traces[0][0].span_id.toString())

              assert.strictEqual(traces[0][4].name, 'apollo.gateway.fetch')
              assert.strictEqual(traces[0][4].parent_id.toString(), traces[0][3].span_id.toString())

              assert.strictEqual(traces[0][5].name, 'apollo.gateway.postprocessing')
              assert.strictEqual(traces[0][5].parent_id.toString(), traces[0][3].span_id.toString())
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
          before(() => agent.load('apollo', { service: 'custom', source: true, signature: false }))
          before(() => setupFixtures())
          before(() => setupApollo(version))

          it('should be configured with the correct values', done => {
            const operationName = 'MyQuery'
            const source = `query ${operationName} { hello(name: "world") }`
            const variableValues = { who: 'world' }
            agent
              .assertSomeTraces((traces) => {
                assert.strictEqual(traces[0][0].name, expectedSchema.server.opName)
                assert.strictEqual(traces[0][0].service, 'custom')
                assert.strictEqual(traces[0][0].resource, `query ${operationName}`)
                assert.strictEqual(traces[0][0].meta['graphql.source'], source)

                assert.strictEqual(traces[0][1].name, 'apollo.gateway.validate')
                assert.strictEqual(traces[0][1].service, 'custom')

                assert.strictEqual(traces[0][2].name, 'apollo.gateway.plan')
                assert.strictEqual(traces[0][2].service, 'custom')

                assert.strictEqual(traces[0][3].name, 'apollo.gateway.execute')
                assert.strictEqual(traces[0][3].service, 'custom')

                assert.strictEqual(traces[0][4].name, 'apollo.gateway.fetch')
                assert.strictEqual(traces[0][4].service, 'custom')

                assert.strictEqual(traces[0][5].name, 'apollo.gateway.postprocessing')
                assert.strictEqual(traces[0][5].service, 'custom')
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
