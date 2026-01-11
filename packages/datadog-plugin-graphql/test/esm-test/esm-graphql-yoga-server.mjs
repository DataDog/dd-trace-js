import 'dd-trace/init.js'
import { createServer } from 'node:http'
import { createSchema, createYoga } from 'graphql-yoga'

const typeDefs = /* GraphQL */ `
  type Query {
    hello(name: String): String
  }
`

const resolvers = {
  Query: {
    hello: (_, { name }) => {
      return `Hello, ${name || 'world'}!`
    }
  }
}

const schema = createSchema({
  typeDefs,
  resolvers
})

const yoga = createYoga({
  schema,
  graphqlEndpoint: '/graphql'
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
