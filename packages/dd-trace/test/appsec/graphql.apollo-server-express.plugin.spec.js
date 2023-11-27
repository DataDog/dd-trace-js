'use strict'

const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')
const {
  books,
  schema,
  resolvers,
  makeGraphqlRequest
} = require('./graphq.test-utils')
withVersions('apollo-server-core', 'express', '>=4', expressVersion => {
  withVersions('apollo-server-core', 'apollo-server-express', apolloServerExpressVersion => {
    let express, expressServer, ApolloServer, gql
    let app, server, port

    before(() => {
      return agent.load(['express', 'graphql', 'apollo-server-core', 'http'], { client: false })
    })

    before(() => {
      const apolloServerExpress =
        require(`../../../../versions/apollo-server-express@${apolloServerExpressVersion}`).get()
      ApolloServer = apolloServerExpress.ApolloServer
      gql = apolloServerExpress.gql

      express = require(`../../../../versions/express@${expressVersion}`).get()
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

      port = await getPort()

      return new Promise(resolve => {
        expressServer = app.listen({ port }, (data) => {
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
      expressServer.close()
    })

    it('Should block an attack', async () => {
      try {
        await makeGraphqlRequest(port, { title: 'testattack' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(json))
      }
    })

    it('Should not block a safe request', async () => {
      const response = await makeGraphqlRequest(port, { title: 'Test' })

      expect(response.data).to.be.deep.equal({ data: { books } })
    })
  })
})
