'use strict'

const path = require('path')
const agent = require('../plugins/agent')
const {
  schema,
  resolvers,
  graphqlCommonTests
} = require('./graphql.test-utils')

withVersions('apollo-server', '@apollo/server', apolloServerVersion => {
  const config = {}
  let ApolloServer, startStandaloneServer
  let server

  before(() => {
    return agent.load(['graphql', 'apollo-server', 'http'], { client: false })
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
