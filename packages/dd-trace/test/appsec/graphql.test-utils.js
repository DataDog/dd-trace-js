'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

const path = require('node:path')
const fs = require('node:fs')

const { graphqlJson, json } = require('../../src/appsec/blocked_templates')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')

const schema = `
directive @case(format: String) on FIELD

type Book {
  title: String,
  author: String
}

type Query {
    books(title: String): [Book!]!
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
    author: 'Test author'
  }
]

const resolvers = {
  Query: {
    books: (root, args, context) => {
      return books.filter(book => {
        return book.title.includes(args.title)
      })
    }
  }
}

async function makeGraphqlRequest (port, variables, derivativeParam, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    ...extraHeaders
  }

  const query = makeQuery(derivativeParam)
  return axios.post(`http://localhost:${port}/graphql`, {
    operationName: 'GetBooks',
    query,
    variables
  }, { headers, maxRedirects: 0 })
}

function graphqlCommonTests (config) {
  describe('Block with content', () => {
    beforeEach(() => {
      appsec.enable(new Config({ appsec: { enabled: true, rules: path.join(__dirname, 'graphql-rules.json') } }))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('Should block an attack on variable', async () => {
      try {
        await makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower')

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(graphqlJson))
      }
    })

    it('Should block an attack on directive', async () => {
      try {
        await makeGraphqlRequest(config.port, { title: 'Test' }, 'testattack')

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(graphqlJson))
      }
    })

    it('Should set appsec.blocked on blocked attack', (done) => {
      agent.assertSomeTraces(payload => {
        expect(payload[0][0].meta['appsec.blocked']).to.be.equal('true')
        done()
      })

      makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower').then(() => {
        done(new Error('block expected'))
      })
    })

    it('Should not block a safe request', async () => {
      const response = await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      expect(response.data).to.be.deep.equal({ data: { books } })
    })

    it('Should block an http attack with graphql response', async () => {
      await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      try {
        await makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower', { customHeader: 'lower' })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(graphqlJson))
      }
    })

    it('Should block an http attack with json response when it is not a graphql endpoint', async () => {
      await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      try {
        await axios.get(`http://localhost:${config.port}/hello`, { headers: { customHeader: 'testattack' } })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(json))
      }
    })
  })

  describe('Block with custom content', () => {
    const blockedTemplateGraphql = path.join(__dirname, 'graphql.block.json')
    const customGraphqlJson = fs.readFileSync(blockedTemplateGraphql)

    beforeEach(() => {
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'graphql-rules.json'),
          blockedTemplateGraphql
        }
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
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(customGraphqlJson))
      }
    })
  })

  describe('Block with redirect', () => {
    beforeEach(() => {
      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'graphql-rules-redirect.json')
        }
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
        expect(e.response.status).to.be.equal(301)
        expect(e.response.headers.location).to.be.equal('/you-have-been-blocked')
      }
    })

    it('Should set appsec.blocked on blocked attack', (done) => {
      agent.assertSomeTraces(payload => {
        expect(payload[0][0].meta['appsec.blocked']).to.be.equal('true')
        done()
      })

      makeGraphqlRequest(config.port, { title: 'testattack' }, 'lower').then(() => {
        done(new Error('block expected'))
      })
    })

    it('Should not block a safe request', async () => {
      const response = await makeGraphqlRequest(config.port, { title: 'Test' }, 'lower')

      expect(response.data).to.be.deep.equal({ data: { books } })
    })
  })
}

module.exports = {
  books,
  schema,
  query,
  resolvers,
  graphqlCommonTests
}
