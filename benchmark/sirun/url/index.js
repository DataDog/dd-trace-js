'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
const { extractURL, obfuscateQs, calculateHttpEndpoint } = require('../../../packages/dd-trace/src/plugins/util/url')
const configManifest = require('../../../packages/dd-trace/src/config/supported-configurations.json')

const COUNT = Number(process.env.COUNT)

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

// Verify the three transforms actually fire before the timed loop: a broken
// helper would otherwise keep sink non-zero and silently "pass".
{
  const secretReq = reqs[3] // .../profile?password=hunter2
  const url = extractURL(secretReq)
  assert.ok(url.includes('example.com'), 'extractURL did not rebuild the request URL')
  assert.ok(!obfuscateQs(config, url).includes('hunter2'), 'obfuscateQs did not redact the secret')
  assert.equal(typeof calculateHttpEndpoint(url), 'string', 'calculateHttpEndpoint did not return a path')
}

guard.loopStart()
let sink = 0
for (let i = 0; i < COUNT; i++) {
  const req = reqs[i & 3]
  const url = extractURL(req)
  sink += obfuscateQs(config, url).length
  sink += calculateHttpEndpoint(url).length
}

assert.ok(sink > 0, 'url bench produced no output')
guard.done()
