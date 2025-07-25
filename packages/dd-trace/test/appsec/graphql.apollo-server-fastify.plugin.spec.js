'use strict'

const agent = require('../plugins/agent')
const {
  schema,
  resolvers,
  graphqlCommonTests
} = require('./graphql.test-utils')

withVersions('apollo-server-core', 'fastify', '3', fastifyVersion => {
  withVersions('apollo-server-core', 'apollo-server-fastify', apolloServerFastifyVersion => {
    const config = {}
    let fastify, ApolloServer, gql
    let app, server

    before(() => {
      return agent.load(['fastify', 'graphql', 'apollo-server-core', 'http'], { client: false })
    })

    before(() => {
      const apolloServerFastify =
        require(`../../../../versions/apollo-server-fastify@${apolloServerFastifyVersion}`).get()
      ApolloServer = apolloServerFastify.ApolloServer
      gql = apolloServerFastify.gql

      fastify = require(`../../../../versions/fastify@${fastifyVersion}`).get()
    })

    before(async () => {
      app = fastify()

      const typeDefs = gql(schema)

      server = new ApolloServer({
        typeDefs,
        resolvers
      })

      await server.start()

      app.register(server.createHandler())

      return new Promise(resolve => {
        app.listen({ port: config.port }, (data) => {
          config.port = app.server.address().port
          resolve()
        })
      })
    })

    after(async () => {
      await server.stop()
      await app.close()
    })

    graphqlCommonTests(config)
  })
})
