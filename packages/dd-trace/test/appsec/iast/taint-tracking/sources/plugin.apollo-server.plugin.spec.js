'use strict'

const { createRequire } = require('node:module')
const agent = require('../../../../plugins/agent')
const { withVersions } = require('../../../../setup/mocha')
const {
  schema,
  resolvers,
  graphqlCommonTests,
} = require('./graphql.sources.test-utils')

withVersions('apollo-server', '@apollo/server', apolloServerVersion => {
  const config = {}
  let ApolloServer, executableSchema, startStandaloneServer
  let server

  before(() => {
    return agent.load(['express', 'graphql', 'apollo-server', 'http'], { client: false })
  })

  before(() => {
    const versionModule = require(`../../../../../../../versions/@apollo/server@${apolloServerVersion}`)
    const apolloServerPath = versionModule.getPath()
    const graphql = require(createRequire(apolloServerPath).resolve('graphql'))

    ApolloServer = require(apolloServerPath).ApolloServer
    startStandaloneServer = versionModule.get('@apollo/server/standalone').startStandaloneServer
    executableSchema = graphql.buildSchema(schema)
    executableSchema.getQueryType().getFields().books.resolve = resolvers.Query.books
  })

  before(async () => {
    server = new ApolloServer({
      schema: executableSchema,
    })

    const { url } = await startStandaloneServer(server, { listen: { port: config.port } })

    config.port = new URL(url).port
  })

  after(async () => {
    await server.stop()
  })

  graphqlCommonTests(config)
})
