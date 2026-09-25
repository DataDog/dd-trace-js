'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
const {
  ClientQueryStringSchema,
  calculateHttpEndpoint,
  extractURL,
  obfuscateQs,
} = require('../../../packages/dd-trace/src/plugins/util/url')
const configManifest = require('../../../packages/dd-trace/src/config/supported-configurations.json')

const OPERATIONS = Number(process.env.OPERATIONS)
const MODE = process.env.MODE

// The per-request server path in addRequestTags runs extractURL (rebuild the URL
// from the request), obfuscateQs (redact secrets from the query string) and
// calculateHttpEndpoint (normalize the path for endpoint aggregation) once per
// inbound request. Compile the shipped default obfuscation regex from the config
// manifest so the bench tracks the production default rather than a hand-copied
// snapshot.
const qsDefault =
  configManifest.supportedConfigurations.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP[0].default
const config = { queryStringObfuscation: new RegExp(qsDefault, 'gi') }

// Duck-typed inbound requests matching what Node's HTTP server hands the tracer:
// headers (host, user-agent), a socket (tls flag) and the raw url. A mix of REST
// paths with int and hex ids, query strings with and without secrets, a plain
// https request, and a short static path.
const socketPlain = { encrypted: false }
const socketTls = { encrypted: true }
const reqs = [
  {
    headers: { host: 'example.com', 'user-agent': 'Mozilla/5.0' },
    socket: socketPlain,
    url: '/api/v2/users/12345/orders?token=abc123def456&page=2',
  },
  {
    headers: { host: 'example.com', 'user-agent': 'curl/8.1.2' },
    socket: socketTls,
    url: '/api/v2/products/list?category=books&sort=price',
  },
  {
    headers: { host: 'example.com', 'user-agent': 'kube-probe/1.29' },
    socket: socketPlain,
    url: '/health',
  },
  {
    headers: { host: 'example.com', 'user-agent': 'Mozilla/5.0' },
    socket: socketTls,
    url: '/api/v2/users/9f8e7d6c5b4a/profile?password=hunter2',
  },
]

const clientQueries = [
  {
    pathname: '/api/v2/users?token=abc123def456&page=2',
    strippedUrl: 'https://example.com/api/v2/users',
    expectedQuery: 'page=<number>&token=<redacted>',
  },
  {
    pathname: '/api/v2/products?category=books&sort=price',
    strippedUrl: 'https://example.com/api/v2/products',
    expectedQuery: 'category=<string>&sort=<string>',
  },
  {
    pathname: '/api/v2/events?id=4f45f5d2-7682-4f1e-9d02-8c3b652a7a4f&at=2026-09-09T12%3A30%3A00Z',
    strippedUrl: 'https://example.com/api/v2/events',
    expectedQuery: 'at=<date>&id=<uuid>',
  },
  {
    pathname: '/api/v2/network?address=192.0.2.1&active=true',
    strippedUrl: 'https://example.com/api/v2/network',
    expectedQuery: 'active=<boolean>&address=<IPv4>',
  },
]

if (MODE === 'client-query-schema') {
  runClientQuerySchema()
} else {
  runEndpointAndObfuscation()
}

function runEndpointAndObfuscation () {
  const secretReq = reqs[3] // .../profile?password=hunter2
  const url = extractURL(secretReq)
  assert.ok(url.includes('example.com'), 'extractURL did not rebuild the request URL')
  assert.ok(!obfuscateQs(config, url).includes('hunter2'), 'obfuscateQs did not redact the secret')
  assert.equal(typeof calculateHttpEndpoint(url), 'string', 'calculateHttpEndpoint did not return a path')

  guard.loopStart()
  let sink = 0
  for (let i = 0; i < OPERATIONS; i++) {
    const req = reqs[i & 3]
    const url = extractURL(req)
    sink += obfuscateQs(config, url).length
    sink += calculateHttpEndpoint(url).length
  }

  assert.ok(sink > 0, 'url bench produced no output')
  guard.done()
}

function runClientQuerySchema () {
  const schema = new ClientQueryStringSchema()
  for (const query of clientQueries) {
    schema.getUrl(config, query.pathname, query.strippedUrl, 'http')
    schema.getUrl(config, query.pathname, query.strippedUrl, 'http')
    const admittedUrl = schema.getUrl(config, query.pathname, query.strippedUrl, 'http')
    assert.strictEqual(admittedUrl, `${query.strippedUrl}?${query.expectedQuery}`)
  }

  guard.loopStart()
  let sink = 0
  for (let i = 0; i < OPERATIONS; i++) {
    const query = clientQueries[i & 3]
    sink += schema.getUrl(config, query.pathname, query.strippedUrl, 'http').length
  }

  assert.ok(sink > 0, 'client query schema bench produced no output')
  guard.done()
}
