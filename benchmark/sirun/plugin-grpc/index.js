'use strict'

const assert = require('node:assert/strict')

const { getMethodMetadata } =
  require('../../../packages/datadog-plugin-grpc/src/util')

const { VARIANT } = process.env

const ITERATIONS = 30_000_000

// Eight realistic gRPC method paths covering 0 / 1 / 2-package layouts so the
// `split('/')` + `serviceParts.split('.')` parse path is exercised under
// realistic megamorphism.
const METHOD_PATHS = [
  '/com.example.UserService/GetUser',
  '/com.example.UserService/CreateUser',
  '/com.example.OrderService/PlaceOrder',
  '/com.example.OrderService/CancelOrder',
  '/com.acme.billing.v1.PaymentService/Charge',
  '/com.acme.billing.v1.PaymentService/Refund',
  '/healthcheck/Check',
  '/healthcheck/Watch',
]

// Pre-flight: confirm the parser still produces a non-empty service name for
// the realistic path. Catches a silent breakage where the function shape
// no longer matches.
const sanity = getMethodMetadata(METHOD_PATHS[0], 'unary')
assert.equal(sanity.name, 'GetUser')
assert.equal(sanity.service, 'UserService')
assert.equal(sanity.package, 'com.example')

if (VARIANT === 'method-metadata') {
  // Per-call parse work `getMethodMetadata` does on every traced gRPC call.
  // Method paths are stable per-service definition, so a hot service hits the
  // same path many times per second.
  let sink = 0
  const len = METHOD_PATHS.length
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    sink ^= getMethodMetadata(METHOD_PATHS[iteration % len], 'unary').name.length
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
} else if (VARIANT === 'peer-parse') {
  // Eight realistic gRPC peer strings. Production hot path: `finish` parses
  // the peer to fill `network.destination.ip` and `network.destination.port`
  // on every traced gRPC RPC.
  const PEERS = [
    'ipv4:10.0.0.1:8080',
    'ipv6:[2001:db8::1]:443',
    'unix:/tmp/grpc.sock',
    '127.0.0.1:50051',
    '[::1]:9000',
    'ipv4:192.168.1.10:6543',
    'ipv4:172.31.5.42:80',
    'unix-abstract:grpc-server',
  ]

  // Inline the production parsing so the bench measures the master shape on
  // master and the rewritten shape after #8327 lands. The function is only
  // called inline inside the client `finish` handler, not exported.
  function parseMaster (peer) {
    const parts = peer.split(':')
    if (/^\d+/.test(parts.at(-1))) {
      const port = parts.at(-1)
      const ip = parts.slice(0, -1).join(':')
      return { ip, port }
    }
    return { ip: peer, port: undefined }
  }

  // Sanity: the parser should distinguish numeric-port endings from non-numeric.
  const sample = parseMaster(PEERS[0])
  assert.equal(sample.port, '8080')
  assert.equal(sample.ip, 'ipv4:10.0.0.1')

  let sink = 0
  const len = PEERS.length
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    sink ^= parseMaster(PEERS[iteration % len]).ip.length
  }
  if (sink === Number.MIN_SAFE_INTEGER) console.log('unreachable', sink)
}
