'use strict'

// express
// apollo-server-express
// load schema

const axios = require('axios')
const getPort = require('get-port')
const path = require('path')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { json } = require('../../src/appsec/blocked_templates')
withVersions('apollo-server-core', 'fastify', '3', fastifyVersion => {
  withVersions('apollo-server-core', 'apollo-server-fastify', apolloServerFastifyVersion => {
    let fastify, ApolloServer, gql
    let app, server, port

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

    const schema = `type Book {
  title: String,
  author: String
}

type Query {
    books(title: String): [Book!]!
}
`

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

      port = await getPort()

      return new Promise(resolve => {
        app.listen({ port }, (data) => {
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

    it('test', async () => {
      const query = `
query GetBooks ($title: String) {
  books(title: $title) {
    title,
    author
  }
}`
      const variables = { title: 'testattack' }
      const headers = {
        'content-type': 'application/json'
      }
      try {
        await axios.post(`http://localhost:${port}/graphql`, {
          operationName: 'GetBooks',
          query,
          variables
        }, { headers })

        return Promise.reject(new Error('Request should not return 200'))
      } catch (e) {
        expect(e.response.status).to.be.equals(403)
        expect(e.response.data).to.be.deep.equal(JSON.parse(json))
      }
    })
  })
})
