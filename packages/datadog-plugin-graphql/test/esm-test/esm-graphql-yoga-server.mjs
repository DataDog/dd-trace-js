import 'dd-trace/init.js'
import { createServer } from 'node:http'
import { createSchema, createYoga } from 'graphql-yoga'

const typeDefs = /* GraphQL */ `
  type Query {
    hello(name: String): String
  }
  type Subscription {
    count: Int
  }
`

const resolvers = {
  Query: {
    hello: (_, { name }) => {
      return `Hello, ${name || 'world'}!`
    },
  },
  Subscription: {
    count: {
      subscribe: async function * () {
        yield { count: 1 }
      },
    },
  },
}

const schema = createSchema({
  typeDefs,
  resolvers,
})

const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql',
})

const server = createServer(yoga)

const port = process.env.PORT || 0

server.listen(port, () => {
  const actualPort = (/** @type {import('net').AddressInfo} */ (server.address())).port
  // Send port to parent process for integration tests
  if (process.send) {
    process.send({ port: actualPort })
  }
})
