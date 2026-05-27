'use strict'

// Realistic post-`format()` trace fixture. The shape mirrors what a typical
// Node.js HTTP service sends: one Express server span at the root, a fan of
// internal middleware spans, a few Postgres / Redis client spans, a couple of
// outbound HTTP client spans, and a few low-level DNS/net spans.
//
// Strings deliberately reuse the same keys and values across spans because that
// is what the string cache sees in production (every span carries `span.kind`,
// `component`, `language`, `runtime-id`, env, version, etc.). Sizes (URLs,
// useragents, SQL statements, stack traces) are chosen to land in the same
// rough bucket as the production trace samples we benchmark against.

const id = require('../../../packages/dd-trace/src/id')

const SERVICE = 'frontend-api'
const ENV = 'production'
const VERSION = '1.42.3'
const HOSTNAME = 'ip-10-0-12-83.ec2.internal'
const RUNTIME_ID = '01999999-1234-5678-90ab-cdef01234567'
const TRACE_TID_HIGH = '6634b8e500000000'
const PROCESS_ID = 12_345
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// One realistic error stack (~1.5 KB) – the formatter slices long strings at
// MAX_META_VALUE_LENGTH, but in production error.stack frequently fills it.
const ERROR_STACK = (
  'Error: connect ECONNREFUSED 10.0.5.42:6379\n' +
  '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1495:16)\n' +
  '    at Socket._final (node:net:480:12)\n' +
  '    at callFinal (node:internal/streams/writable:701:27)\n' +
  '    at prefinish (node:internal/streams/writable:734:7)\n' +
  '    at finishMaybe (node:internal/streams/writable:744:5)\n' +
  '    at Writable.end (node:internal/streams/writable:642:5)\n' +
  '    at RedisSocket.connect (/app/node_modules/@redis/client/dist/lib/client/socket.js:122:14)\n' +
  '    at RedisClient.connect (/app/node_modules/@redis/client/dist/lib/client/index.js:241:21)\n' +
  '    at Object.<anonymous> (/app/dist/services/cache.js:18:12)\n' +
  '    at Module._compile (node:internal/modules/cjs/loader:1554:14)'
)

const MIDDLEWARE_NAMES = [
  'helmet', 'cors', 'compression', 'bodyParser.json', 'cookieParser',
  'session', 'passport.initialize', 'passport.session', 'csurf', 'authenticate',
  'rateLimiter', 'requestLogger', 'tenantResolver',
]

const SQL_STATEMENTS = [
  'SELECT u.id, u.email, u.name, u.created_at, p.bio, p.avatar_url FROM users u ' +
    'LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1 LIMIT 1',
  'SELECT id, title, body, author_id, published_at FROM posts ' +
    'WHERE author_id = $1 AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 20',
  'UPDATE sessions SET last_seen_at = NOW(), ip_address = $2 WHERE id = $1',
  'INSERT INTO audit_log (actor_id, action, target_id, payload) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
  'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL',
  'SELECT 1',
]

const REDIS_COMMANDS = [
  'GET user:123:profile',
  'SETEX session:abcd1234 3600',
  'HMGET feature_flags:tenant:42 dark_mode billing_v2',
  'INCR ratelimit:ip:10.0.5.42:GET:/api/users',
  'EXPIRE ratelimit:ip:10.0.5.42:GET:/api/users 60',
]

const HTTP_DOWNSTREAMS = [
  { method: 'GET', url: 'https://auth.internal.example.com/v1/sessions/abcd1234/validate', service: 'auth-service' },
  { method: 'POST', url: 'https://billing.internal.example.com/v2/usage/record', service: 'billing-service' },
  { method: 'GET', url: 'https://search.internal.example.com/v3/index/posts?q=node.js&limit=20', service: 'search-service' },
]

function commonMeta () {
  return {
    language: 'javascript',
    'runtime-id': RUNTIME_ID,
    env: ENV,
    version: VERSION,
    '_dd.p.dm': '-1',
    '_dd.p.tid': TRACE_TID_HIGH,
  }
}

function commonMetrics () {
  return {
    _sampling_priority_v1: 1,
    process_id: PROCESS_ID,
    '_dd.tracer_kr': 1,
    '_dd.agent_psr': 1,
  }
}

function makeServerSpan (traceId, parentId, startNs) {
  return {
    trace_id: traceId,
    span_id: id(),
    parent_id: parentId,
    name: 'express.request',
    resource: 'GET /api/users/:id/feed',
    service: SERVICE,
    type: 'web',
    error: 0,
    start: startNs,
    duration: 47_321_456,
    meta: {
      ...commonMeta(),
      'span.kind': 'server',
      component: 'express',
      'http.method': 'GET',
      'http.url': 'https://api.example.com/api/users/123/feed?include=posts,profile&limit=20',
      'http.route': '/api/users/:id/feed',
      'http.status_code': '200',
      'http.useragent': USER_AGENT,
      'http.client_ip': '10.0.5.42',
      'http.host': 'api.example.com',
      'network.client.ip': '10.0.5.42',
      '_dd.base_service': SERVICE,
      '_dd.origin': '',
      '_dd.hostname': HOSTNAME,
    },
    metrics: {
      ...commonMetrics(),
      '_dd.measured': 1,
      '_dd.top_level': 1,
      '_dd.rule_psr': 1,
      '_dd.limit_psr': 1,
    },
  }
}

function makeMiddlewareSpan (traceId, parentId, startNs, index) {
  const middlewareName = MIDDLEWARE_NAMES[index % MIDDLEWARE_NAMES.length]
  return {
    trace_id: traceId,
    span_id: id(),
    parent_id: parentId,
    name: 'express.middleware',
    resource: middlewareName,
    service: SERVICE,
    type: 'web',
    error: 0,
    start: startNs,
    duration: 213_456,
    meta: {
      ...commonMeta(),
      'span.kind': 'internal',
      component: 'express',
      'express.type': 'middleware',
      'resource.name': middlewareName,
    },
    metrics: {
      ...commonMetrics(),
    },
  }
}

function makePostgresSpan (traceId, parentId, startNs, index) {
  const statement = SQL_STATEMENTS[index % SQL_STATEMENTS.length]
  return {
    trace_id: traceId,
    span_id: id(),
    parent_id: parentId,
    name: 'pg.query',
    resource: statement.slice(0, 60),
    service: `${SERVICE}-postgres`,
    type: 'sql',
    error: 0,
    start: startNs,
    duration: 4_123_789,
    meta: {
      ...commonMeta(),
      'span.kind': 'client',
      component: 'pg',
      'db.type': 'postgres',
      'db.name': 'production_app',
      'db.user': 'app_reader',
      'db.instance': 'production_app',
      'db.statement': statement,
      'out.host': 'db-replica-3.internal.example.com',
      'network.destination.name': 'db-replica-3.internal.example.com',
      'peer.service': 'production_app',
      '_dd.peer.service.source': 'db.instance',
      '_dd.base_service': SERVICE,
    },
    metrics: {
      ...commonMetrics(),
      '_dd.measured': 1,
      'network.destination.port': 5432,
      'db.row_count': 17,
    },
  }
}

function makeRedisSpan (traceId, parentId, startNs, index) {
  const command = REDIS_COMMANDS[index % REDIS_COMMANDS.length]
  return {
    trace_id: traceId,
    span_id: id(),
    parent_id: parentId,
    name: 'redis.command',
    resource: command.split(' ', 1)[0],
    service: `${SERVICE}-redis`,
    type: 'redis',
    error: 0,
    start: startNs,
    duration: 312_456,
    meta: {
      ...commonMeta(),
      'span.kind': 'client',
      component: 'redis',
      'db.type': 'redis',
      'db.name': '0',
      'redis.raw_command': command,
      'out.host': 'cache-primary.internal.example.com',
      'network.destination.name': 'cache-primary.internal.example.com',
      'peer.service': 'cache-primary',
      '_dd.peer.service.source': 'out.host',
      '_dd.base_service': SERVICE,
    },
    metrics: {
      ...commonMetrics(),
      '_dd.measured': 1,
      'network.destination.port': 6379,
    },
  }
}

function makeHttpClientSpan (traceId, parentId, startNs, index) {
  const downstream = HTTP_DOWNSTREAMS[index % HTTP_DOWNSTREAMS.length]
  return {
    trace_id: traceId,
    span_id: id(),
    parent_id: parentId,
    name: 'http.request',
    resource: downstream.method,
    service: `${SERVICE}-http-client`,
    type: 'http',
    error: 0,
    start: startNs,
    duration: 8_421_657,
    meta: {
      ...commonMeta(),
      'span.kind': 'client',
      component: 'http',
      'http.method': downstream.method,
      'http.url': downstream.url,
      'http.status_code': '200',
      'out.host': new URL(downstream.url).host,
      'network.destination.name': new URL(downstream.url).host,
      'peer.service': downstream.service,
      '_dd.peer.service.source': 'out.host',
      '_dd.base_service': SERVICE,
    },
    metrics: {
      ...commonMetrics(),
      '_dd.measured': 1,
      'network.destination.port': 443,
    },
  }
}

function makeDnsSpan (traceId, parentId, startNs, host) {
  return {
    trace_id: traceId,
    span_id: id(),
    parent_id: parentId,
    name: 'dns.lookup',
    resource: host,
    service: SERVICE,
    type: 'dns',
    error: 0,
    start: startNs,
    duration: 142_876,
    meta: {
      ...commonMeta(),
      'span.kind': 'internal',
      component: 'dns',
      'dns.hostname': host,
    },
    metrics: {
      ...commonMetrics(),
    },
  }
}

function makeErrorSpan (traceId, parentId, startNs) {
  return {
    trace_id: traceId,
    span_id: id(),
    parent_id: parentId,
    name: 'redis.command',
    resource: 'CONNECT',
    service: `${SERVICE}-redis`,
    type: 'redis',
    error: 1,
    start: startNs,
    duration: 1_004_211,
    meta: {
      ...commonMeta(),
      'span.kind': 'client',
      component: 'redis',
      'db.type': 'redis',
      'out.host': 'cache-primary.internal.example.com',
      'error.type': 'Error',
      'error.message': 'connect ECONNREFUSED 10.0.5.42:6379',
      'error.stack': ERROR_STACK,
      '_dd.base_service': SERVICE,
    },
    metrics: {
      ...commonMetrics(),
      '_dd.measured': 1,
    },
  }
}

/**
 * Build a single realistic Node.js HTTP-request trace.
 *
 * Layout for the default 30-span trace:
 *   - 1 root `express.request` (server)
 *   - 13 `express.middleware` spans (internal, kind=internal)
 *   - 6 `pg.query` (sql/client)
 *   - 4 `redis.command` (cache/client)
 *   - 3 `http.request` outbound (client)
 *   - 2 `dns.lookup` (internal)
 *   - 1 error `redis.command` carrying error.message/error.stack
 *
 * @param {number} [spanCount] total number of spans in the trace (default 30).
 * @returns {object[]}
 */
function buildTrace (spanCount = 30) {
  const trace = []
  const rootStart = 1_715_926_535_897_000_000
  const traceId = id()
  const rootSpan = makeServerSpan(traceId, id('0'), rootStart)
  trace.push(rootSpan)

  // Composition is proportional, so callers can scale spanCount up or down.
  const remaining = spanCount - 1
  const counts = {
    middleware: Math.round(remaining * 0.45),
    pg: Math.round(remaining * 0.21),
    redis: Math.round(remaining * 0.14),
    http: Math.round(remaining * 0.10),
    dns: Math.round(remaining * 0.07),
  }
  counts.error = Math.max(0, remaining - counts.middleware - counts.pg - counts.redis - counts.http - counts.dns)

  let offsetNs = 200_000
  let middlewareIndex = 0

  for (let i = 0; i < counts.middleware; i++) {
    trace.push(makeMiddlewareSpan(traceId, rootSpan.span_id, rootStart + offsetNs, middlewareIndex++))
    offsetNs += 350_000
  }
  for (let i = 0; i < counts.pg; i++) {
    trace.push(makePostgresSpan(traceId, rootSpan.span_id, rootStart + offsetNs, i))
    offsetNs += 4_200_000
  }
  for (let i = 0; i < counts.redis; i++) {
    trace.push(makeRedisSpan(traceId, rootSpan.span_id, rootStart + offsetNs, i))
    offsetNs += 320_000
  }
  for (let i = 0; i < counts.http; i++) {
    const httpSpan = makeHttpClientSpan(traceId, rootSpan.span_id, rootStart + offsetNs, i)
    trace.push(httpSpan)
    offsetNs += 8_500_000
    if (counts.dns > 0) {
      const dnsHost = new URL(HTTP_DOWNSTREAMS[i % HTTP_DOWNSTREAMS.length].url).host
      trace.push(makeDnsSpan(traceId, httpSpan.span_id, rootStart + offsetNs, dnsHost))
      counts.dns--
      offsetNs += 150_000
    }
  }
  while (counts.dns > 0) {
    trace.push(makeDnsSpan(traceId, rootSpan.span_id, rootStart + offsetNs, 'api.example.com'))
    counts.dns--
    offsetNs += 150_000
  }
  for (let i = 0; i < counts.error; i++) {
    trace.push(makeErrorSpan(traceId, rootSpan.span_id, rootStart + offsetNs))
    offsetNs += 1_000_000
  }

  return trace
}

const EVENT_ATTRIBUTES_HTTP_OK = { attempt: 1, ratio: 0.5, ok: true, kind: 'http.client', codes: [200, 204] }
const EVENT_ATTRIBUTES_HTTP_ERR = { attempt: 2, ratio: 0.6, ok: false, kind: 'http.server', codes: [500, 503] }
const EVENT_ATTRIBUTES_DB = { attempt: 3, ratio: 0.7, ok: true, kind: 'db.query', codes: [42] }

/**
 * `encoder.encode` consumes `span_events`: the legacy path stringifies them
 * into `meta.events` and clears the field; the native path mutates each
 * attribute primitive into a typed wrapper. The trace is reused across
 * iterations, so re-attach fresh events before every encode.
 *
 * @param {object[]} trace
 */
function attachFreshEvents (trace) {
  for (const span of trace) {
    span.span_events = [
      { name: 'http.attempt', time_unix_nano: 1_715_926_535_897_000_000, attributes: { ...EVENT_ATTRIBUTES_HTTP_OK } },
      { name: 'http.failure', time_unix_nano: 1_715_926_535_898_000_000, attributes: { ...EVENT_ATTRIBUTES_HTTP_ERR } },
      { name: 'db.query', time_unix_nano: 1_715_926_535_899_000_000, attributes: { ...EVENT_ATTRIBUTES_DB } },
    ]
  }
}

module.exports = { buildTrace, attachFreshEvents }
