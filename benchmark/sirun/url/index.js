'use strict'

const { extractURL, obfuscateQs, calculateHttpEndpoint } = require('../../../packages/dd-trace/src/plugins/util/url')

const COUNT = Number(process.env.COUNT)

// The shipped default query-string obfuscation regex. The per-request server
// path in addRequestTags runs extractURL (rebuild the URL from the request),
// obfuscateQs (redact secrets from the query string) and calculateHttpEndpoint
// (normalize the path for endpoint aggregation) once per inbound request.
const qsRegex = new RegExp(
  '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|' +
  'token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)' +
  '(?:(?:\\s|%20)*(?:=|%3D)[^&]+)|bearer(?:\\s|%20)+[a-z0-9\\._\\-]+|token(?::|%3A)[a-z0-9]{13}|' +
  'gh[opsu]_[0-9a-zA-Z]{36}',
  'gi'
)
const config = { queryStringObfuscation: qsRegex }

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

let sink = 0
for (let i = 0; i < COUNT; i++) {
  const req = reqs[i & 3]
  const url = extractURL(req)
  sink += obfuscateQs(config, url).length
  sink += calculateHttpEndpoint(url).length
}

if (sink === 0) throw new Error('unreachable')
