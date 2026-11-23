import tracer from 'dd-trace'
import { Elysia } from 'elysia'

tracer.init({ startupLogs: false, flushInterval: 10 })

const app = new Elysia()
  .get('/users/:id', ({ params }) => params.id)
  .listen({ port: 0, hostname: '127.0.0.1', development: false })

process.send({ port: app.server.port })
