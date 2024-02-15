'use strict'

const getPort = require('get-port')
const path = require('path')
const agent = require('../../../../plugins/agent')
const {
  schema,
  resolvers,
  graphqlCommonTests
} = require('./graphql.sources.test-utils')

withVersions('apollo-server', '@apollo/server', apolloServerVersion => {
  const config = {}
  let ApolloServer, startStandaloneServer
  let server

  before(() => {
    return agent.load(['express', 'graphql', 'apollo-server', 'http'], { client: false })
  })

  before(() => {
    const apolloServerPath = require(`../../../../../../../versions/@apollo/server@${apolloServerVersion}`).getPath()

    ApolloServer = require(apolloServerPath).ApolloServer
    startStandaloneServer = require(path.join(apolloServerPath, '..', 'standalone')).startStandaloneServer
  })

  before(async () => {
    server = new ApolloServer({
      typeDefs: schema,
      resolvers
    })

    config.port = await getPort()

    await startStandaloneServer(server, { listen: { port: config.port } })
  })

  after(async () => {
    await server.stop()
  })

  graphqlCommonTests(config)
})
