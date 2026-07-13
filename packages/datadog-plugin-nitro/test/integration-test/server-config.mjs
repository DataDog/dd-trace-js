import tracer from 'dd-trace'
import http from 'node:http'
import { H3, toNodeHandler } from 'h3'

tracer.init()
tracer.use('nitro', {
  service: 'configured-nitro',
  validateStatus: status => status < 600,
  hooks: {
    request (span) {
      span.setTag('nitro.request_hook', 'true')
    },
  },
})

const app = new H3()
app.get('/response-error', () => new Response('bad', { status: 503 }))

const server = http.createServer(toNodeHandler(app))
// Bind on all interfaces (no host) so the test client can reach it whether
// `localhost` resolves to IPv4 (127.0.0.1) or IPv6 (::1) on the CI runner.
server.listen(0, () => {
  process.send({ port: server.address().port })
})
