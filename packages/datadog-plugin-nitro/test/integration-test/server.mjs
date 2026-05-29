import 'dd-trace/init.js'
import { H3, toNodeHandler } from 'h3'
import { tracingPlugin } from 'h3/tracing'
import http from 'node:http'

const app = new H3()
app.register(tracingPlugin())
app.get('/hello', () => ({ ok: true }))

const server = http.createServer(toNodeHandler(app))
server.listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port })
})
