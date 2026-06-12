import 'dd-trace/init.js'
import http from 'node:http'
import { H3, toNodeHandler } from 'h3'

const app = new H3()
app.get('/hello', () => ({ ok: true }))
app.get('/users/:id', event => ({ id: event.context.params.id }))
app.get('/error', () => {
  throw new Error('nitro test boom')
})

const server = http.createServer(toNodeHandler(app))
// Bind on all interfaces (no host) so the test client can reach it whether
// `localhost` resolves to IPv4 (127.0.0.1) or IPv6 (::1) on the CI runner.
server.listen(0, () => {
  process.send({ port: server.address().port })
})
