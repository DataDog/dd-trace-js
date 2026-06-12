import 'dd-trace/init.js'
import http from 'node:http'
import { H3, toNodeHandler } from 'h3'
import { tracingPlugin } from 'h3/tracing'

// Simulates an app that ALSO manually enables h3's native tracing plugin on top
// of dd-trace's automatic instrumentation. The handler must still be wrapped
// only once, producing a single span per request (no double instrumentation).
const app = new H3()
app.register(tracingPlugin())
app.get('/hello', () => ({ ok: true }))

const server = http.createServer(toNodeHandler(app))
// Bind on all interfaces (no host) so the test client can reach it whether
// `localhost` resolves to IPv4 (127.0.0.1) or IPv6 (::1) on the CI runner.
server.listen(0, () => {
  process.send({ port: server.address().port })
})
