import 'dd-trace/init.js'
import Fastify from 'fastify'
import mercurius from 'mercurius'

const schema = `
  type Query {
    hello(name: String): String
  }
`

const resolvers = {
  Query: {
    hello: (_, { name }) => `Hello, ${name || 'world'}!`,
  },
}

const app = Fastify()
app.register(mercurius, { schema, resolvers })

await app.listen({ port: 0 })
const port = app.server.address().port
process.send({ port })
