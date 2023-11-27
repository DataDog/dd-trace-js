'use strict'

const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
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
      app = fastify()

      const typeDefs = gql(schema)

      server = new ApolloServer({
        typeDefs,
        resolvers
      })

      await server.start()

      app.register(server.createHandler())

      config.port = await getPort()

      return new Promise(resolve => {
        app.listen({ port: config.port }, (data) => {
          resolve()
        })
      })
    })

    beforeEach(() => {
      appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'graphql-rules.json') } }))
    })

    afterEach(() => {
      appsec.disable()
    })

    after(async () => {
      await server.stop()
      await app.close()
    })

    graphqlCommonTests(config)
  })
})
