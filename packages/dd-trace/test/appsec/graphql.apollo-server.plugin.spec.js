'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const appsec = require('../../src/appsec')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const { withVersions } = require('../setup/mocha')
const {
  schema,
  resolvers,
  graphqlCommonTests,
  makeGraphqlRequest,
} = require('./graphql.test-utils')
const { blockedTemplateGraphql, setTestBlockingTemplates } = require('./utils')

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
      resolvers,
    })

    const { url } = await startStandaloneServer(server, { listen: { port: 0 } })

    config.port = new URL(url).port
  })

  after(async () => {
    await server.stop()
  })

  describe('Empty resolver blocking', () => {
    afterEach(() => appsec.disable())

    it('should retain custom field-name blocking for empty resolvers', async () => {
      appsec.enable(getConfigFresh({
        appsec: { enabled: true, rules: path.join(__dirname, 'graphql-field-rules.json') },
      }))
      setTestBlockingTemplates()

      await assert.rejects(makeGraphqlRequest(config.port, { title: 'Test' }, 'lower'), error => {
        assert.strictEqual(error.response.status, 403)
        assert.deepStrictEqual(error.response.data, JSON.parse(blockedTemplateGraphql))
        return true
      })
    })
  })

  graphqlCommonTests(config)
})
