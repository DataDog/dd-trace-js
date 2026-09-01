import 'dd-trace/init.js'
import Fastify from 'fastify'
import { parse } from 'graphql'
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

const parsedDocument = parse('query ParsedAstWarmDisabled { hello(name: "parsed") }')

const app = Fastify()
app.register(mercurius, {
  schema,
  resolvers,
  jit: process.env.MERCURIUS_JIT === '1' ? 1 : 0,
})
app.get('/parsed', () => app.graphql(parsedDocument))

await app.listen({ port: 0 })
const port = app.server.address().port
process.send({ port })
