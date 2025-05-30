'use strict'

const axios = require('axios')
const agent = require('../../../../plugins/agent')
const iast = require('../../../../../src/appsec/iast')
const Config = require('../../../../../src/config')
const vulnerabilityReporter = require('../../../../../src/appsec/iast/vulnerability-reporter')
const overheadController = require('../../../../../src/appsec/iast/overhead-controller')

const schema = `
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

const queryWithHardcodedArgument = `
query GetBooks {
  books(title: "ls") {
    title,
    author
  }
}`

const books = [
  {
    title: 'Test title',
    author: 'Test author'
  }
]

const resolvers = {
  Query: {
    books: (root, args, context) => {
      const { execSync } = require('child_process')
      execSync(args.title)
      return books.filter(book => {
        return book.title.includes(args.title)
      })
    }
  }
}

async function makeGraphqlRequest (port, query, variables = {}) {
  const headers = {
    'content-type': 'application/json'
  }

  return axios.post(`http://localhost:${port}/graphql`, {
    operationName: 'GetBooks',
    query,
    variables
  }, { headers, maxRedirects: 0 })
}

function graphqlCommonTests (config) {
  describe('Graphql sources tests', () => {
    beforeEach(() => {
      iast.enable(new Config({
        experimental: {
          iast: {
            enabled: true,
            requestSampling: 100
          }
        }
      }))
      vulnerabilityReporter.clearCache()
      overheadController.clearGlobalRouteMap()
    })

    afterEach(() => {
      iast.disable()
    })

    it('Should detect COMMAND_INJECTION vulnerability with hardcoded query', (done) => {
      agent.assertSomeTraces(payload => {
        expect(payload[0][0].meta).to.have.property('_dd.iast.json')

        const iastJson = JSON.parse(payload[0][0].meta['_dd.iast.json'])
        expect(iastJson.vulnerabilities[0].type).to.be.equal('COMMAND_INJECTION')
        done()
      })

      makeGraphqlRequest(config.port, queryWithHardcodedArgument)
    })

    it('Should detect COMMAND_INJECTION vulnerability with query and variables', (done) => {
      agent.assertSomeTraces(payload => {
        expect(payload[0][0].meta).to.have.property('_dd.iast.json')

        const iastJson = JSON.parse(payload[0][0].meta['_dd.iast.json'])
        expect(iastJson.vulnerabilities[0].type).to.be.equal('COMMAND_INJECTION')
        done()
      })

      makeGraphqlRequest(config.port, query, {
        title: 'test'
      })
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
