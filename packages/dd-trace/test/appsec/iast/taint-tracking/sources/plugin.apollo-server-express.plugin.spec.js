'use strict'

const agent = require('../../../../plugins/agent')
const { withVersions } = require('../../../../setup/mocha')
const {
  schema,
  resolvers,
  graphqlCommonTests
} = require('./graphql.sources.test-utils')

withVersions('graphql', 'express', '>=4', expressVersion => {
  withVersions('graphql', 'apollo-server-express', apolloServerExpressVersion => {
    const config = {}
    let express, expressServer, ApolloServer, gql
    let app, server

    before(() => {
      return agent.load(['express', 'graphql', 'http'], { client: false })
    })

    before(() => {
      const apolloServerExpress =
        require(`../../../../../../../versions/apollo-server-express@${apolloServerExpressVersion}`).get()
      ApolloServer = apolloServerExpress.ApolloServer
      gql = apolloServerExpress.gql

      express = require(`../../../../../../../versions/express@${expressVersion}`).get()
    })

    before(async () => {
      app = express()

      const typeDefs = gql(schema)

      server = new ApolloServer({
        typeDefs,
        resolvers
      })

      await server.start()

      server.applyMiddleware({ app })

      return new Promise(resolve => {
        expressServer = app.listen({ port: config.port }, () => {
          config.port = expressServer.address().port
          resolve()
        })
      })
    })

    after(async () => {
      await server.stop()
      expressServer.close()
    })

    graphqlCommonTests(config)
  })
})
