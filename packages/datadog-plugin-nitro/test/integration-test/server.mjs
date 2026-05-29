import 'dd-trace/init.js'
import http from 'node:http'
import { H3, toNodeHandler } from 'h3'

const app = new H3()
app.get('/hello', () => ({ ok: true }))

const server = http.createServer(toNodeHandler(app))
server.listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port })
})
