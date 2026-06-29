import Fastify from 'fastify'

function throwFromTypeScript (): void {
  throw new Error('boom from typescript')
}

const app = Fastify()

app.get('/', async function handler () {
  throwFromTypeScript()
  return { hello: 'world' }
})

app.listen({ port: process.env.APP_PORT || 0 }, (error: Error | null) => {
  if (error) throw error
  process.send?.({ port: app.server.address().port })
})
