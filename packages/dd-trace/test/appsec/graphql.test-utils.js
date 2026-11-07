'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const appsec = require('../../src/appsec')
const addresses = require('../../src/appsec/addresses')
const waf = require('../../src/appsec/waf')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const httpRequest = require('../setup/helpers/http-client')
const { blockedTemplateJson: json, blockedTemplateGraphql: graphqlJson, setTestBlockingTemplates } = require('./utils')

const schema = `
directive @case(format: String) on FIELD

type Book {
  title: String,
  author: String
}

type Query {
    books(title: String): [Book!]!
    login(id: String): String
}`

const query = `
query GetBooks ($title: String) {
  books(title: $title) {
    title,
    author
  }
}`

function makeQuery (derivativeParam) {
  return `
    query GetBooks ($title: String) {
      books(title: $title) @case(format: "${derivativeParam}") {
        title
        author
      }
    }`
}

const books = [
  {
    title: 'Test title',
    author: 'Test author',
  },
]

const resolvers = {
  Query: {
    books: (root, args, context) => {
      return books.filter(book => {
        return book.title.includes(args.title)
      })
    },
    login: (root, args) => {
      require('../../').appsec.setUser({ id: args.id })
      return args.id
    },
  },
  Book: {
    // An explicit resolver, so every Apollo version publishes this argument-less field to AppSec.
    author: book => book.author,
  },
}

async function makeGraphqlRequest (port, variables, derivativeParam, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    ...extraHeaders,
  }

  const query = makeQuery(derivativeParam)
  return httpRequest.post(`http://localhost:${port}/graphql`, {
    operationName: 'GetBooks',
    query,
    variables,
  }, { headers, maxRedirects: 0 })
}

/**
 * Earlier tests block identical requests and their traces can arrive late, so only accept the trace of this request.
 *
 * @param {number} port
 * @param {number} status
 * @param {string} userAgent
 */
function assertBlockedRequestTrace (port, status, userAgent) {
  return Promise.all([
    agent.assertSomeTraces(payload => {
      assert.strictEqual(payload[0][0].meta['http.useragent'], userAgent)
      assert.strictEqual(payload[0][0].meta['appsec.blocked'], 'true')
    }),
    assert.rejects(
      makeGraphqlRequest(port, { title: 'testattack' }, 'lower', { 'user-agent': userAgent }),
      error => error.response.status === status
    ),
  ])
}

function postGraphqlQuery (port, query) {
  return httpRequest.post(`http://localhost:${port}/graphql`, { query }, {
    headers: { 'content-type': 'application/json' },
    maxRedirects: 0,
  })
}

/**
 * Counts the WAF runs that checked `fieldName`.
 *
 * @param {sinon.SinonSpy} wafRun
 * @param {string} fieldName
 */
function countFieldRuns (wafRun, fieldName) {
  return wafRun.getCalls().filter(call => {
    const resolverInfo = call.args[0]?.ephemeral?.[addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]
    return resolverInfo?.[fieldName] !== undefined
  }).length
}

function graphqlCommonTests (config) {
  describe('Block with content', () => {
    beforeEach(() => {
      appsec.enable(getConfigFresh({ appsec: { enabled: true, rules: path.join(__dirname, 'graphql-rules.json') } }))
      setTestBlockingTemplates()
    })

    afterEach(() => {
      appsec.disable()
    })

    it('Should block an attack on variable', async () => {
      try {
        await makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower')

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepStrictEqual(e.response.data, JSON.parse(graphqlJson))
      }
    })

    it('Should block an attack on directive', async () => {
      try {
        await makeGraphqlRequest(config.port, { title: 'Test' }, 'testattack')

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepStrictEqual(e.response.data, JSON.parse(graphqlJson))
      }
    })

    it('Should set appsec.blocked on blocked attack', () => {
      return assertBlockedRequestTrace(config.port, 403, 'graphql-blocked-with-content')
    })

    it('Should not block a safe request', async () => {
      const response = await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      assert.deepStrictEqual(response.data, { data: { books } })
    })

    it('Should block an http attack with graphql response', async () => {
      await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      try {
        await makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower', { customHeader: 'lower' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepStrictEqual(e.response.data, JSON.parse(graphqlJson))
      }
    })

    it('Should block an http attack with json response when it is not a graphql endpoint', async () => {
      await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      try {
        await httpRequest.get(`http://localhost:${config.port}/hello`, { headers: { customHeader: 'testattack' } })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepStrictEqual(e.response.data, JSON.parse(json))
      }
    })
  })

  describe('Block with custom content', () => {
    const blockedTemplateGraphql = path.join(__dirname, 'graphql.block.json')
    const customGraphqlJson = fs.readFileSync(blockedTemplateGraphql, { encoding: 'utf8' })

    beforeEach(() => {
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'graphql-rules.json'),
          blockedTemplateGraphql,
        },
      }))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('Should block an attack on variable', async () => {
      try {
        await makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower')

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 403)
        assert.deepStrictEqual(e.response.data, JSON.parse(customGraphqlJson))
      }
    })
  })

  describe('Block on field name', () => {
    beforeEach(() => {
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'graphql-field-name-rules.json'),
        },
      }))
      setTestBlockingTemplates()
    })

    afterEach(() => {
      appsec.disable()
    })

    it('Should block a request selecting a field without arguments', async () => {
      const error = await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower').then(() => null, error => error)

      assert.ok(error, 'Request should not return 200')
      assert.strictEqual(error.response.status, 403)
      assert.deepStrictEqual(error.response.data, JSON.parse(graphqlJson))
    })
  })

  describe('WAF runs for fields without arguments', () => {
    let wafRun

    /**
     * @param {string} rules
     */
    function enableAppsecWithWafSpy (rules) {
      appsec.enable(getConfigFresh({ appsec: { enabled: true, rules: path.join(__dirname, rules) } }))
      setTestBlockingTemplates()
      // Enabling AppSec replaces `waf.run`, so the spy goes on afterwards.
      wafRun = sinon.spy(waf, 'run')
    }

    afterEach(() => {
      wafRun.restore()
      appsec.disable()
    })

    it('Should run the WAF once for a field resolved through several aliases', async () => {
      enableAppsecWithWafSpy('graphql-rules.json')

      const response = await postGraphqlQuery(config.port, `
        query {
          books(title: "Test") {
            first: author
            second: author
            third: author
          }
        }`)

      const author = books[0].author
      assert.deepStrictEqual(response.data, {
        data: { books: [{ first: author, second: author, third: author }] },
      })
      assert.strictEqual(countFieldRuns(wafRun, 'author'), 1)
    })

    it('Should run the WAF once for repeated Boolean directive inputs', async () => {
      enableAppsecWithWafSpy('graphql-rules.json')

      for (const directive of ['@include(if: true)', '@skip(if: false)', '@include(if: true) @skip(if: false)']) {
        wafRun.resetHistory()
        const response = await postGraphqlQuery(config.port, `
          query {
            books(title: "Test") {
              first: author ${directive}
              second: author ${directive}
              third: author ${directive}
            }
          }`)

        const author = books[0].author
        assert.strictEqual(countFieldRuns(wafRun, 'author'), 1)
        assert.deepStrictEqual(response.data, {
          data: { books: [{ first: author, second: author, third: author }] },
        })
      }
    })

    it('Should run the WAF again for a field once setUser adds a user to the request', async () => {
      enableAppsecWithWafSpy('graphql-user-field-rules.json')

      for (const directive of ['', '@include(if: true)', '@skip(if: false)', '@include(if: true) @skip(if: false)']) {
        wafRun.resetHistory()
        // The rule needs both the user and the field, so only the `author` resolved after `login` can block.
        await assert.rejects(postGraphqlQuery(config.port, `
          query {
            before: books(title: "Test") { author ${directive} }
            login(id: "blocked-user")
            after: books(title: "Test") { author ${directive} }
          }`), error => {
          assert.strictEqual(error.response.status, 403)
          assert.deepStrictEqual(error.response.data, JSON.parse(graphqlJson))
          return true
        })
        assert.strictEqual(countFieldRuns(wafRun, 'author'), 2)
      }
    })
  })

  describe('Block with redirect', () => {
    beforeEach(() => {
      appsec.enable(getConfigFresh({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'graphql-rules-redirect.json'),
        },
      }))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('Should block an attack', async () => {
      try {
        await makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower')

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        assert.strictEqual(e.response.status, 301)
        assert.strictEqual(e.response.headers.location, '/you-have-been-blocked')
      }
    })

    it('Should set appsec.blocked on blocked attack', () => {
      return assertBlockedRequestTrace(config.port, 301, 'graphql-blocked-with-redirect')
    })

    it('Should not block a safe request', async () => {
      const response = await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      assert.deepStrictEqual(response.data, { data: { books } })
    })
  })
}

module.exports = {
  books,
  schema,
  query,
  resolvers,
  graphqlCommonTests,
}
