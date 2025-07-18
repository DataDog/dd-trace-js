'use strict'

const path = require('path')
const agent = require('../plugins/agent')
const {
  schema,
  resolvers,
  graphqlCommonTests
} = require('./graphq.test-utils')

withVersions('apollo-server', '@apollo/server', '>=4.0.0 <5.0.0', apolloServerVersion => {
  const config = {}
  let ApolloServer, startStandaloneServer
  let server

  before(() => {
    return agent.load(['express', 'graphql', 'apollo-server', 'http'], { client: false })
  })

  before(() => {
    const apolloServerPath = require(`../../../../versions/@apollo/server@${apolloServerVersion}`).getPath()

    ApolloServer = require(apolloServerPath).ApolloServer
    startStandaloneServer = require(path.join(apolloServerPath, '..', 'standalone')).startStandaloneServer
  })

  before(async () => {
    server = new ApolloServer({
      typeDefs: schema,
      resolvers
    })

    const { url } = await startStandaloneServer(server, { listen: { port: 0 } })

    config.port = new URL(url).port
  })

  after(async () => {
    await server.stop()
  })

  graphqlCommonTests(config)
})
