'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')

const accounts = require('./fixtures.js')

const graphqlTag = require(`../../../versions/graphql-tag`).get()
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
  let tracer

  function gateway () {
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
    return gateway.load().then(({ executor }) => executor)
  }

  describe('@apollo/gateway', () => {
    withVersions('apollo-gateway', '@apollo/gateway', version => {
      before(() => {
        tracer = require('../../dd-trace')
        const apollo = require(`../../../versions/@apollo/gateway@${version}`).get()
        const subgraph = require(`../../../versions/@apollo/subgraph@${version}`).get()
        buildSubgraphSchema = subgraph.buildSubgraphSchema
        ApolloGateway = apollo.ApolloGateway
        LocalGraphQLDataSource = apollo.LocalGraphQLDataSource
      })
      after(() => {
        return agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('apollo-gateway')
        })
        it('should instrument apollo-gateway', done => {
          const operationName = 'MyQuery'
          const resource = `query ${operationName}`
          const source = `${resource} { hello(name: "world") }`
          const variableValues = { who: 'world' }
          agent
            .use((traces) => {
              // the spans are in order of execution
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('resource', resource)
              expect(traces[0][0]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('graphql.operation.name', operationName)
              expect(traces[0][0].meta).to.have.property('graphql.source', source)
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'query')
              expect(traces[0][0].meta).to.have.property('component', 'apollo-gateway')

              expect(traces[0][1]).to.have.property('name', 'apollo-gateway.validate')
              expect(traces[0][1]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][1]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][1]).to.have.property('error', 0)
              expect(traces[0][1].meta).to.have.property('component', 'apollo-gateway')

              expect(traces[0][2]).to.have.property('name', 'apollo-gateway.plan')
              expect(traces[0][2]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][2]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][2]).to.have.property('error', 0)
              expect(traces[0][2].meta).to.have.property('component', 'apollo-gateway')

              expect(traces[0][3]).to.have.property('name', 'apollo-gateway.execute')
              expect(traces[0][3]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][3]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][3]).to.have.property('error', 0)
              expect(traces[0][3].meta).to.have.property('component', 'apollo-gateway')

              expect(traces[0][4]).to.have.property('name', 'apollo-gateway.fetch')
              expect(traces[0][4]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][4]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][4]).to.have.property('error', 0)
              expect(traces[0][4].meta).to.have.property('serviceName', 'accounts')
              expect(traces[0][4].meta).to.have.property('component', 'apollo-gateway')

              expect(traces[0][5]).to.have.property('name', 'apollo-gateway.postprocessing')
              expect(traces[0][5]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][5]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][5]).to.have.property('error', 0)
              expect(traces[0][5].meta).to.have.property('component', 'apollo-gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(executor => {
              return execute(executor, source, variableValues, operationName).then(() => {})
            })
        })

        it('should instrument schema resolver', done => {
          const source = `{ hello(name: "world") }`
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'query')
              expect(traces[0][0]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('graphql.source', source)
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'query')
              expect(traces[0][0].meta).to.have.property('component', 'apollo-gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(executor => {
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
            .use((traces) => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('resource', 'query')
              expect(traces[0][0]).to.have.property('type', 'apollo-gateway')
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('graphql.source', source)
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'query')
              expect(traces[0][0].meta).to.have.property('component', 'apollo-gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(executor => {
              return execute(executor, source).then(() => {})
            })
        })

        it('should instrument mutations', done => {
          const source = `mutation { human { name } }`

          agent
            .use((traces) => {
              expect(traces[0][0].meta).to.have.property('graphql.operation.type', 'mutation')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(executor => {
              return execute(executor, source).then(() => {})
            })
        })

        it('should handle a circular schema', done => {
          const source = `{ human { pets { owner { name } } } }`

          gateway()
            .then(executor => {
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
            .use((traces) => {
              expect(traces[0].length).equal(2)
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'apollo-gateway')

              expect(traces[0][1]).to.have.property('name', 'apollo-gateway.validate')
              expect(traces[0][1]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][1]).to.have.property('error', 1)
              expect(traces[0][1].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][1].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][1].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][1].meta).to.have.property('component', 'apollo-gateway')
            })
            .then(done)
            .catch(done)

          gateway()
            .then(executor => {
              return execute(executor, source, variableValues, 'InvalidVariables').then((result) => {
                error = result.errors[1]
              })
            })
        })

        it('should instrument plan failure', done => {
          let error
          const operationName = 'MyQuery'
          const resource = `subscription ${operationName}`
          const source = `${resource} { hello(name: "world") }`
          const variableValues = { who: 'world' }
          agent
            .use((traces) => {
              expect(traces[0].length).equal(3)
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][0]).to.have.property('error', 1)

              expect(traces[0][1]).to.have.property('name', 'apollo-gateway.validate')
              expect(traces[0][1]).to.have.property('error', 0)

              expect(traces[0][2]).to.have.property('name', 'apollo-gateway.plan')
              expect(traces[0][2]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][2]).to.have.property('error', 1)
              expect(traces[0][2].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][2].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][2].meta).to.have.property(ERROR_STACK, error.stack)
            })
            .then(done)
            .catch(done)

          gateway()
            .then(executor => {
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
          const resource = `query ${operationName}`
          const source = `${resource} { hello(name: "world") }`
          const variableValues = { who: 'world' }
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)

              expect(traces[0][1]).to.have.property('name', 'apollo-gateway.validate')
              expect(traces[0][1]).to.have.property('error', 0)

              expect(traces[0][2]).to.have.property('name', 'apollo-gateway.plan')
              expect(traces[0][2]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][2]).to.have.property('error', 0)

              expect(traces[0][3]).to.have.property('name', 'apollo-gateway.execute')
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

              expect(traces[0][4]).to.have.property('name', 'apollo-gateway.fetch')
              expect(traces[0][4]).to.have.property('service', expectedSchema.server.serviceName)
              expect(traces[0][4]).to.have.property('error', 1)
              expect(traces[0][4].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][4].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][4].meta).to.have.property(ERROR_STACK, error.stack)

              expect(traces[0][5]).to.have.property('name', 'apollo-gateway.postprocessing')
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
          const resource = `query ${operationName}`
          const source = `${resource} { hello(name: "world") }`
          const variableValues = { who: 'world' }

          agent
            .use((traces) => {
              // the spans are in order of execution
              expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)

              expect(traces[0][1]).to.have.property('name', 'apollo-gateway.validate')
              expect(traces[0][1].parent_id.toString()).to.equal(traces[0][0].span_id.toString())

              expect(traces[0][2]).to.have.property('name', 'apollo-gateway.plan')
              expect(traces[0][2].parent_id.toString()).to.equal(traces[0][0].span_id.toString())

              expect(traces[0][3]).to.have.property('name', 'apollo-gateway.execute')
              expect(traces[0][3].parent_id.toString()).to.equal(traces[0][0].span_id.toString())

              expect(traces[0][4]).to.have.property('name', 'apollo-gateway.fetch')
              expect(traces[0][4].parent_id.toString()).to.equal(traces[0][3].span_id.toString())

              expect(traces[0][5]).to.have.property('name', 'apollo-gateway.postprocessing')
              expect(traces[0][5].parent_id.toString()).to.equal(traces[0][3].span_id.toString())
            })
            .then(done)
            .catch(done)

          gateway()
            .then(executor => {
              return execute(executor, source, variableValues, operationName).then(() => {})
            })
        })

        withNamingSchema(
          () => {
            const operationName = 'MyQuery'
            const resource = `query ${operationName}`
            const source = `${resource} { hello(name: "world") }`
            const variableValues = { who: 'world' }
            gateway()
              .then(executor => {
                return execute(executor, source, variableValues, operationName).then(() => {})
              })
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
            return agent.load('apollo-gateway', { service: 'custom' })
          })

          it('should be configured with the correct values', done => {
            const operationName = 'MyQuery'
            const resource = `query ${operationName}`
            const source = `${resource} { hello(name: "world") }`
            const variableValues = { who: 'world' }
            agent
              .use((traces) => {
                expect(traces[0][0]).to.have.property('name', expectedSchema.server.opName)
                expect(traces[0][0]).to.have.property('service', 'custom')

                expect(traces[0][1]).to.have.property('name', 'apollo-gateway.validate')
                expect(traces[0][1]).to.have.property('service', 'custom')

                expect(traces[0][2]).to.have.property('name', 'apollo-gateway.plan')
                expect(traces[0][2]).to.have.property('service', 'custom')

                expect(traces[0][3]).to.have.property('name', 'apollo-gateway.execute')
                expect(traces[0][3]).to.have.property('service', 'custom')

                expect(traces[0][4]).to.have.property('name', 'apollo-gateway.fetch')
                expect(traces[0][4]).to.have.property('service', 'custom')

                expect(traces[0][5]).to.have.property('name', 'apollo-gateway.postprocessing')
                expect(traces[0][5]).to.have.property('service', 'custom')
              })
              .then(done)
              .catch(done)

            gateway()
              .then(executor => {
                return execute(executor, source, variableValues, operationName).then(() => {})
              })
          })
        })
      })
    })
  })
})
