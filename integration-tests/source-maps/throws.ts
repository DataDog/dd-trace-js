const Fastify = require('fastify')

function throwFromTypeScript (): void {
  throw new Error('boom from typescript')
}

const app = Fastify()

app.get('/', async function handler () {
  throwFromTypeScript()
  return { hello: 'world' }
})

app.listen({ port: Number(process.env.APP_PORT) || 0 }, (error: Error | null) => {
  if (error) throw error
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('Fastify did not listen on a TCP port')
  process.send?.({ port: address.port })
})
