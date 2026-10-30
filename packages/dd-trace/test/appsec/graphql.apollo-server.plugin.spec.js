'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const sinon = require('sinon')

const appsec = require('../../src/appsec')
const waf = require('../../src/appsec/waf')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const { withVersions } = require('../setup/mocha')
const {
  books,
  schema,
  observeNativeContexts,
  resolverRuns,
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
    const sandbox = sinon.createSandbox()

    afterEach(() => {
      sandbox.restore()
      appsec.disable()
    })

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

    it('should retain value-based blocking after a safe rule update', async () => {
      appsec.enable(getConfigFresh({ appsec: { enabled: true } }))
      setTestBlockingTemplates()
      const rules = structuredClone(require('./graphql-field-rules.json'))
      delete rules.rules[0].transformers
      rules.rules[0].conditions[0].parameters.list = ['Test']
      waf.updateConfig('ASM_DD', 'value-rule', 'datadog/00/ASM_DD/value-rule/config', rules)

      await assert.rejects(makeGraphqlRequest(config.port, { title: 'Test' }, 'lower'), error => {
        assert.strictEqual(error.response.status, 403)
        assert.deepStrictEqual(error.response.data, JSON.parse(blockedTemplateGraphql))
        return true
      })
    })

    it('should retain field-name blocking when an accepted update does not publish a native instance', async () => {
      appsec.enable(getConfigFresh({ appsec: { enabled: true } }))
      setTestBlockingTemplates()
      const configPath = 'datadog/00/ASM_DD/field-rules/config'
      waf.updateConfig('ASM_DD', 'field-rules', configPath, require('./graphql-field-rules.json'))
      waf.updateConfig('ASM_DD', 'field-rules', configPath, { version: '2.2', actions: [] })
      waf.checkAsmDdFallback()

      await assert.rejects(makeGraphqlRequest(config.port, { title: 'Test' }, 'lower'), error => {
        assert.strictEqual(error.response.status, 403)
        assert.deepStrictEqual(error.response.data, JSON.parse(blockedTemplateGraphql))
        return true
      })

      waf.removeConfig(configPath)
      waf.checkAsmDdFallback()
      const contexts = observeNativeContexts(sandbox)
      const response = await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')
      assert.strictEqual(resolverRuns(contexts).length, 1)
      assert.deepStrictEqual(response.data, { data: { books } })
    })

    it('should preserve an active request snapshot when rules change during resolution', async () => {
      appsec.enable(getConfigFresh({ appsec: { enabled: true } }))
      setTestBlockingTemplates()
      let updated = false
      sandbox.stub(books[0], 'title').get(() => {
        if (!updated) {
          updated = true
          waf.updateConfig('ASM_DD', 'field-rules', 'datadog/00/ASM_DD/field-rules/config',
            require('./graphql-field-rules.json'))
        }
        return 'Test title'
      })

      const response = await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')
      assert.deepStrictEqual(response.data, { data: { books } })
      await assert.rejects(makeGraphqlRequest(config.port, { title: 'Test' }, 'lower'), error => {
        assert.strictEqual(error.response.status, 403)
        assert.deepStrictEqual(error.response.data, JSON.parse(blockedTemplateGraphql))
        return true
      })
    })
  })

  graphqlCommonTests(config)
})
