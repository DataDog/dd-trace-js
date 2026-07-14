import 'dd-trace/init.js'
import { createServer } from 'node:http'

import graphql from 'graphql'
import { compileQuery } from 'graphql-jit'

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
    },
  }),
})
const document = graphql.parse('query ESMJit { hello }')
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

  const result = await query({}, {}, {})
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(result))
}

const server = createServer(handleRequest)

const port = process.env.PORT || 0

server.listen(port, () => {
  const actualPort = (/** @type {import('node:net').AddressInfo} */ (server.address())).port
  if (process.send) {
    process.send({ port: actualPort })
  }
})
