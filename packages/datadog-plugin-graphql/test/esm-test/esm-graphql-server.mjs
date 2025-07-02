import 'dd-trace/init.js'
import graphql from 'graphql'
import { createServer } from 'node:http'

const schema = new graphql.GraphQLSchema({
  query: new graphql.GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: graphql.GraphQLString,
        args: {
          name: { type: graphql.GraphQLString }
        },
        resolve (obj, args) {
          return `Hello, ${args.name || 'world'}!`
        }
      }
    }
  })
})

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/graphql') {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })
    req.on('end', async () => {
      try {
        const { query, variables } = JSON.parse(body)
        const result = await graphql.graphql({
          schema,
          source: query,
          variableValues: variables
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
    })
  } else {
    res.writeHead(404)
    res.end('Not Found')
  }
})

const port = process.env.PORT || 0

server.listen(port, () => {
  const actualPort = server.address().port
  // Send port to parent process for integration tests
  if (process.send) {
    process.send({ port: actualPort })
  }
})
