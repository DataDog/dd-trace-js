import 'dd-trace/init.js'
import { createServer } from 'node:http'

import dc from 'dc-polyfill'
import graphql from 'graphql'
import { compileQuery } from 'graphql-jit'

const User = new graphql.GraphQLObjectType({
  name: 'User',
  fields: {
    name: { type: graphql.GraphQLString },
  },
})

const schema = new graphql.GraphQLSchema({
  query: new graphql.GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: graphql.GraphQLString,
        resolve () {
          return 'world'
        },
      },
      user: {
        type: User,
        resolve () {
          return { name: 'Ada' }
        },
      },
    },
  }),
})

const warmResult = graphql.execute({
  schema,
  document: graphql.parse('query ESMWarm { hello user { name } }'),
})
if (warmResult.errors) throw warmResult.errors[0]

if (process.env.ABORT_GRAPHQL_JIT) {
  /** @param {{ abortController: AbortController }} message */
  dc.channel('apm:graphql:execute:start').subscribe(({ abortController }) => {
    abortController.abort()
  })
}

/** @type {Record<string, number>} */
const resolverCalls = {}
/** @param {{ resolverInfo: Record<string, unknown> }} message */
dc.channel('datadog:graphql:resolver:start').subscribe(({ resolverInfo }) => {
  const [fieldName] = Object.keys(resolverInfo)
  resolverCalls[fieldName] = (resolverCalls[fieldName] ?? 0) + 1
})

const document = graphql.parse('query ESMJit { hello user { name } }')
const { query } = compileQuery(schema, document)

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
async function handleRequest (request, response) {
  if (request.url !== '/graphql') {
    response.writeHead(404)
    response.end('Not Found')
    return
  }

  try {
    const result = await query({}, {}, {})
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Resolver-Calls': JSON.stringify(resolverCalls),
    })
    response.end(JSON.stringify(result))
  } catch (error) {
    if (error?.name !== 'AbortError') throw error

    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: error.name }))
  }
}

const server = createServer(handleRequest)

const port = process.env.PORT || 0

server.listen(port, () => {
  const actualPort = (/** @type {import('node:net').AddressInfo} */ (server.address())).port
  if (process.send) {
    process.send({ port: actualPort })
  }
})
