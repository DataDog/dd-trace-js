import 'dd-trace/init.js'
import http from 'node:http'
import { H3, toNodeHandler } from 'h3'
import { tracingPlugin } from 'h3/tracing'

const app = new H3()
// h3's core H3 class does NOT use tracingChannel('h3.request') natively — only the
// tracingPlugin from 'h3/tracing' attaches the diagnostic-channel hooks that the
// dd-trace nitro plugin subscribes to. Register it explicitly so the ESM integration
// test produces tracing:h3.request:* events (matches test-setup.js for unit tests).
app.register(tracingPlugin())
app.get('/hello', () => ({ ok: true }))

const server = http.createServer(toNodeHandler(app))
server.listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port })
})
