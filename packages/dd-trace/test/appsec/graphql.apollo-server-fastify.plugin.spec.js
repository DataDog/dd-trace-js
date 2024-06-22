'use strict'

const http = require('http')
const agent = require('../plugins/agent')
const {
  schema,
  resolvers,
  graphqlCommonTests
} = require('./graphq.test-utils')

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
      let appListener

      const serverFactory = (handler, opts) => {
        appListener = http.createServer((req, res) => {
          handler(req, res)
        })

        return appListener
      }

      app = fastify({ serverFactory })

      const typeDefs = gql(schema)

      server = new ApolloServer({
        typeDefs,
        resolvers
      })

      await server.start()

      app.register(server.createHandler())

      return new Promise(resolve => {
        app.listen({ port: config.port }, (data) => {
          config.port = appListener.address().port
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
