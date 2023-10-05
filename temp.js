require('.').init()
const Fastify = require('fastify')
// const middie = require('@fastify/middie')
// const fastify = require('fastify')
// const http = require('http')

// const fastifyExport = fastify.getExport()

// const app = fastifyExport()

const app = Fastify()

// app = app.register(require('@fastify/middie'))

app.get('/', async (request, reply) => {
  reply.send('hello world')
  // return { hello: 'world' }
  await app.close()
})

app.listen({ port: 3000 }, (err, address) => {
  if (err) throw err
  // Server is now listening on ${address}
  console.log('server is now listening on: 3000')
})
