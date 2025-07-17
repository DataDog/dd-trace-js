require('dd-trace/init')

// @ts-ignore - fastify will be available at runtime
import Fastify from 'fastify'

const app = Fastify({
  logger: true
})

app.get('/', async function handler () {
  return { hello: 'world' }
})

app.listen({ port: process.env.APP_PORT || 0 }, (err) => {
  if (err) throw err
  process.send?.({ port: app.server.address().port })
})
