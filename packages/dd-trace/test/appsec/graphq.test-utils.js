const axios = require('axios')
const { graphqlJson } = require('../../src/appsec/blocked_templates')
const agent = require('../plugins/agent')

const schema = `type Book {
  title: String,
  author: String
}

type Query {
    books(title: String): [Book!]!
}
`
const query = `
query GetBooks ($title: String) {
  books(title: $title) {
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
      return books.filter(book => {
        return book.title.includes(args.title)
      })
    }
  }
}

async function makeGraphqlRequest (port, variables, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    ...extraHeaders
  }
  return axios.post(`http://localhost:${port}/graphql`, {
    operationName: 'GetBooks',
    query,
    variables
  }, { headers })
}

function graphqlCommonTests (config) {
  it('Should block an attack', async () => {
    try {
      await makeGraphqlRequest(config.port, { title: 'testattack' })

      return Promise.reject(new Error('Request should not return 200'))
    } catch (e) {
      expect(e.response.status).to.be.equals(403)
      expect(e.response.data).to.be.deep.equal(JSON.parse(graphqlJson))
    }
  })

  it('Should set appsec.blocked on blocked attack', (done) => {
    agent.use(payload => {
      expect(payload[0][0].meta['appsec.blocked']).to.be.equal('true')
      done()
    })

    makeGraphqlRequest(config.port, { title: 'testattack' }).then(() => {
      done(new Error('block expected'))
    })
  })

  it('Should not block a safe request', async () => {
    const response = await makeGraphqlRequest(config.port, { title: 'Test' })

    expect(response.data).to.be.deep.equal({ data: { books } })
  })

  it('Should block an http attack with graphql response', async () => {
    await makeGraphqlRequest(config.port, { title: 'Test' })
    try {
      await makeGraphqlRequest(config.port, { title: 'Test' }, { customHeader: 'testattack' })

      return Promise.reject(new Error('Request should not return 200'))
    } catch (e) {
      expect(e.response.status).to.be.equals(403)
      expect(e.response.data).to.be.deep.equal(JSON.parse(graphqlJson))
    }
  })
}
module.exports = {
  books,
  schema,
  query,
  resolvers,
  makeGraphqlRequest,
  graphqlCommonTests
}
