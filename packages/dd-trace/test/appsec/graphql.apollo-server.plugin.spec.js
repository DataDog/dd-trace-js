'use strict'

const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { graphqlJson } = require('../../src/appsec/blocked_templates')
const {
  books,
  schema,
  resolvers,
  makeGraphqlRequest
} = require('./graphq.test-utils')

withVersions('apollo-server', '@apollo/server', apolloServerVersion => {
  let ApolloServer, startStandaloneServer
  let server, port

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

    port = await getPort()

    await startStandaloneServer(server, { listen: { port } })
  })

  beforeEach(() => {
    appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'graphql-rules.json') } }))
  })

  afterEach(() => {
    appsec.disable()
  })

  after(async () => {
    await server.stop()
  })

  it('Should block an attack', async () => {
    try {
      await makeGraphqlRequest(port, { title: 'testattack' })

      return Promise.reject(new Error('Request should not return 200'))
    } catch (e) {
      expect(e.response.status).to.be.equals(403)
      expect(e.response.data).to.be.deep.equal(JSON.parse(graphqlJson))
    }
  })

  it('Should not block a safe request', async () => {
    const response = await makeGraphqlRequest(port, { title: 'Test' })

    expect(response.data).to.be.deep.equal({ data: { books } })
  })
})
