'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const GrpcClientPlugin = require('../../../packages/datadog-plugin-grpc/src/client')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 5_000_000

// Every gRPC client call walks `bindStart`: parse the `/pkg.Service/Method` path
// (cached per path) into name/service/package, assemble the method meta bag, and
// start the span. Subclass the real plugin and override only the tracer-reaching
// hooks so the measured surface is the method-metadata resolution and meta build.
let lastMeta
const FAKE_SPAN = { setTag () {}, finish () {} }
class BenchedGrpcPlugin extends GrpcClientPlugin {
  addSub () {}
  addBind () {}
  addTraceBind () {}
  operationName () { return 'grpc.client' }
  serviceName () { return 'grpc-prod' }
  startSpan (name, options) {
    lastMeta = options?.meta
    return FAKE_SPAN
  }
}

const tracer = { _service: 'web-app', _env: 'prod', _version: '1.0.0', inject () {} }
const plugin = new BenchedGrpcPlugin(tracer, { spanComputePeerService: false })
plugin.configure({ enabled: true, service: 'grpc-prod' })

// A service definition exposes a small, finite set of method paths; the parser
// caches each one, so steady state is the cache hit plus the meta assembly.
const PATHS = [
  '/google.pubsub.v1.Publisher/Publish',
  '/google.pubsub.v1.Subscriber/Pull',
  '/orders.v2.OrderService/CreateOrder',
  '/orders.v2.OrderService/GetOrder',
  '/inventory.InventoryService/Reserve',
  '/Health/Check',
]

const VARIANTS = {
  unary: [PATHS[2]],
  mixed: PATHS,
}

const paths = VARIANTS[VARIANT]
assert.ok(paths, `unknown VARIANT: ${VARIANT}`)

const messages = paths.map((path) => ({ path, type: 'unary', metadata: undefined }))

for (const message of messages) {
  lastMeta = undefined
  plugin.bindStart(message)
  assert.ok(lastMeta && typeof lastMeta['grpc.method.path'] === 'string', 'bindStart did not build the method meta')
}

const len = messages.length
guard.loopStart()
for (let i = 0; i < ITERATIONS; i++) {
  plugin.bindStart(messages[i % len])
}
guard.done()

assert.ok(lastMeta, 'startSpan stub was never reached')
