'use strict'

// Realistic post-`format()` trace fixture. The shape mirrors what a typical
// Node.js HTTP service sends: one Express server span at the root, a fan of
// internal middleware spans, a few Postgres / Redis client spans, a couple of
// outbound HTTP client spans, and a few low-level DNS/net spans.
//
// Strings deliberately reuse the same keys and values across spans because
// that is what the string cache sees in production (every span carries
// `span.kind`, `component`, `language`, `runtime-id`, env, version, etc.).
// Sizes (URLs, useragents, SQL statements, stack traces) are chosen to land
// in the same rough bucket as the production trace samples we benchmark
// against.
//
// The trace object is reused across iterations to keep allocation cost out
// of the measurement, but `tickTrace` mutates the per-request dynamic
// fields (timestamps, durations, ID bytes, event times, a handful of
// status codes / row counts) before every encode. Without that, every
// iteration encodes byte-identical data and V8 can collapse the integer
// magnitude branches the encoder is meant to exercise.

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

// Realistic error stacks (~1.5 KB each). The formatter slices long strings at
// MAX_META_VALUE_LENGTH; in production `error.stack` frequently fills it.
// `tickTrace` rotates the error span through the pool so the encoder's
// large-string path (which bypasses the v0.4 cache and walks `_stringBytes`
// directly on the v0.5 wire) doesn't see one cached value forever.
const ERROR_VARIANTS = [
  {
    type: 'Error',
    message: 'connect ECONNREFUSED 10.0.5.42:6379',
    stack: 'Error: connect ECONNREFUSED 10.0.5.42:6379\n' +
      '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1495:16)\n' +
      '    at Socket._final (node:net:480:12)\n' +
      '    at callFinal (node:internal/streams/writable:701:27)\n' +
      '    at prefinish (node:internal/streams/writable:734:7)\n' +
      '    at finishMaybe (node:internal/streams/writable:744:5)\n' +
      '    at Writable.end (node:internal/streams/writable:642:5)\n' +
      '    at RedisSocket.connect (/app/node_modules/@redis/client/dist/lib/client/socket.js:122:14)\n' +
      '    at RedisClient.connect (/app/node_modules/@redis/client/dist/lib/client/index.js:241:21)\n' +
      '    at Object.<anonymous> (/app/dist/services/cache.js:18:12)\n' +
      '    at Module._compile (node:internal/modules/cjs/loader:1830:14)',
  },
  {
    type: 'TimeoutError',
    message: 'Query timeout exceeded after 5000ms',
    stack: 'TimeoutError: Query timeout exceeded after 5000ms\n' +
      '    at Timeout._onTimeout (/app/node_modules/pg-pool/index.js:184:25)\n' +
      '    at listOnTimeout (node:internal/timers:573:17)\n' +
      '    at process.processTimers (node:internal/timers:514:7)\n' +
      '    at PostgresAdapter.query (/app/dist/db/postgres.js:124:18)\n' +
      '    at async UserRepository.findFeed (/app/dist/repos/user.js:71:24)\n' +
      '    at async FeedController.get (/app/dist/controllers/feed.js:32:21)\n' +
      '    at async dispatch (/app/node_modules/express/lib/router/route.js:128:14)\n' +
      '    at async Layer.handleRequest (/app/node_modules/express/lib/router/layer.js:95:5)\n' +
      '    at async next (/app/node_modules/express/lib/router/route.js:144:13)\n' +
      '    at async Function.handle (/app/node_modules/express/lib/router/index.js:284:10)',
  },
  {
    type: 'ValidationError',
    message: 'invalid request body: field "user_id" is required',
    stack: 'ValidationError: invalid request body: field "user_id" is required\n' +
      '    at Validator.validate (/app/node_modules/joi/lib/validator.js:91:14)\n' +
      '    at SessionService.create (/app/dist/services/session.js:48:18)\n' +
      '    at AuthController.login (/app/dist/controllers/auth.js:62:34)\n' +
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\n' +
      '    at async dispatch (/app/node_modules/express/lib/router/route.js:128:14)\n' +
      '    at async Layer.handleRequest (/app/node_modules/express/lib/router/layer.js:95:5)\n' +
      '    at async next (/app/node_modules/express/lib/router/route.js:144:13)\n' +
      '    at async Function.handle (/app/node_modules/express/lib/router/index.js:284:10)\n' +
      '    at async tracedHandler (/app/node_modules/dd-trace/lib/plugins/express.js:43:18)',
  },
  {
    type: 'HTTPError',
    message: 'Request to upstream "billing-service" failed: 503 Service Unavailable',
    stack: 'HTTPError: Request to upstream "billing-service" failed: 503 Service Unavailable\n' +
      '    at HttpClient.handleResponse (/app/dist/clients/http.js:217:13)\n' +
      '    at Object.onceWrapper (node:events:631:28)\n' +
      '    at IncomingMessage.emit (node:events:517:28)\n' +
      '    at endReadableNT (node:internal/streams/readable:1421:12)\n' +
      '    at process.processTicksAndRejections (node:internal/process/task_queues:82:21)\n' +
      '    at async BillingService.recordUsage (/app/dist/services/billing.js:71:14)\n' +
      '    at async UsageMiddleware.afterRequest (/app/dist/middleware/usage.js:38:7)\n' +
      '    at async dispatch (/app/node_modules/express/lib/router/route.js:128:14)\n' +
      '    at async Layer.handleRequest (/app/node_modules/express/lib/router/layer.js:95:5)\n' +
      '    at async next (/app/node_modules/express/lib/router/route.js:144:13)',
  },
]

// Per-request server-span variance. Each entry is a coherent "request
// shape": the route, the URL that hits it, the resource name we report,
// the client IP it came from, and the status code it returns. Rotating
// through these on every encode keeps the encoder's string cache seeing
// the production pattern of "most requests are 200 on a small handful
// of routes, occasional 4xx/5xx, cold values appear regularly".
const REQUEST_VARIANTS = [
  {
    route: '/api/users/:id/feed',
    url: 'https://api.example.com/api/users/123/feed?include=posts,profile&limit=20',
    resource: 'GET /api/users/:id/feed',
    clientIp: '10.0.5.42',
    status: '200',
  },
  {
    route: '/api/users/:id/feed',
    url: 'https://api.example.com/api/users/8472/feed?include=posts',
    resource: 'GET /api/users/:id/feed',
    clientIp: '10.0.6.118',
    status: '200',
  },
  {
    route: '/api/posts/:id/comments',
    url: 'https://api.example.com/api/posts/74201/comments?page=2&limit=50',
    resource: 'GET /api/posts/:id/comments',
    clientIp: '10.0.7.91',
    status: '200',
  },
  {
    route: '/api/sessions',
    url: 'https://api.example.com/api/sessions',
    resource: 'POST /api/sessions',
    clientIp: '10.0.5.42',
    status: '201',
  },
  {
    route: '/api/notifications',
    url: 'https://api.example.com/api/notifications?unread_only=true',
    resource: 'GET /api/notifications',
    clientIp: '10.0.8.13',
    status: '200',
  },
  {
    route: '/api/search',
    url: 'https://api.example.com/api/search?q=node.js+tracing&page=1',
    resource: 'GET /api/search',
    clientIp: '10.0.5.77',
    status: '200',
  },
  {
    route: '/api/users/:id',
    url: 'https://api.example.com/api/users/9988',
    resource: 'GET /api/users/:id',
    clientIp: '10.0.4.201',
    status: '404',
  },
  {
    route: '/api/billing/usage',
    url: 'https://api.example.com/api/billing/usage?from=2026-05-01&to=2026-05-27',
    resource: 'POST /api/billing/usage',
    clientIp: '10.0.3.55',
    status: '500',
  },
]

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

// `MutableIdentifier` shadows the public surface of `packages/dd-trace/src/id.js`
// that the encoder actually uses (`toBuffer`, `toArray`), but exposes the
// backing `Uint8Array` so `tickTrace` can rewrite per-request bytes without
// touching the real `Identifier`'s private cache fields (which would go stale
// after the first `toString` / `toBigInt` call). The encoder never calls
// `toString` on these in either v0.4 or v0.5, so the shorter contract is fine.
class MutableIdentifier {
  /** @param {number} seed deterministic per-span seed so spans are distinguishable before the first tick. */
  constructor (seed) {
    const buffer = new Uint8Array(8)
    // Knuth multiplier (2654435761) gives well-spread bytes across small seeds.
    let x = (seed * 2_654_435_761) >>> 0
    // Force the top bit clear so the int64 stays positive, matching the
    // production `pseudoRandom` shape in id.js.
    buffer[0] = (x >>> 24) & 0x7F
    buffer[1] = (x >>> 16) & 0xFF
    buffer[2] = (x >>> 8) & 0xFF
    buffer[3] = x & 0xFF
    x = ((x ^ (x >>> 16)) * 0x85_eb_ca_6b) >>> 0
    buffer[4] = (x >>> 24) & 0xFF
    buffer[5] = (x >>> 16) & 0xFF
    buffer[6] = (x >>> 8) & 0xFF
    buffer[7] = x & 0xFF
    this._buffer = buffer
  }

  toBuffer () { return this._buffer }
  toArray () { return this._buffer }
}

// The agent's intake refuses negative parent_id, so the root parent is a
// zero buffer (matches `id('0')` in production).
const ZERO_ID = (() => {
  const idObj = new MutableIdentifier(0)
  idObj._buffer.fill(0)
  return idObj
})()

let idSeed = 1
function newId () {
  return new MutableIdentifier(idSeed++)
}

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
  const variant = REQUEST_VARIANTS[0]
  return {
    trace_id: traceId,
    span_id: newId(),
    parent_id: parentId,
    name: 'express.request',
    resource: variant.resource,
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
      'http.url': variant.url,
      'http.route': variant.route,
      'http.status_code': variant.status,
      'http.useragent': USER_AGENT,
      'http.client_ip': variant.clientIp,
      'http.host': 'api.example.com',
      'network.client.ip': variant.clientIp,
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
    span_id: newId(),
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
    span_id: newId(),
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
    span_id: newId(),
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
  const host = new URL(downstream.url).host
  return {
    trace_id: traceId,
    span_id: newId(),
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
      'out.host': host,
      'network.destination.name': host,
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
    span_id: newId(),
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
  const variant = ERROR_VARIANTS[0]
  return {
    trace_id: traceId,
    span_id: newId(),
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
      'error.type': variant.type,
      'error.message': variant.message,
      'error.stack': variant.stack,
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
 * The returned trace is meant to be reused across iterations; call
 * `tickTrace(trace, iteration)` before each encode to refresh the
 * per-request dynamic fields.
 *
 * @param {number} [spanCount] total number of spans in the trace (default 30).
 * @returns {object[]}
 */
function buildTrace (spanCount = 30) {
  const trace = []
  const rootStart = 1_715_926_535_897_000_000
  const traceId = newId()
  const rootSpan = makeServerSpan(traceId, ZERO_ID, rootStart)
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

  // Pin the base value of every per-request dynamic field so `tickTrace`
  // can lay each iteration's delta on top of it without re-deriving the
  // offset within the trace.
  for (const span of trace) {
    span._baseStart = span.start
    span._baseDuration = span.duration
    if (span.metrics['db.row_count'] !== undefined) span._baseRowCount = span.metrics['db.row_count']
  }

  // Cache the two spans whose string fields rotate per iteration so
  // `tickTrace` doesn't walk the trace looking for them.
  trace._errorSpan = trace.find((span) => span.error === 1)

  return trace
}

/**
 * Refresh the per-request dynamic fields on a reused trace so each encode
 * sees production-shaped variance: monotonically advancing timestamps, a
 * narrow duration jitter that stays inside the uint32 magnitude band, new
 * low ID bytes (which collapses the encoder's per-span uint64 reads into
 * a real load each time), rotating db row counts, a rotating server-span
 * request shape (route / URL / resource / status / client IP), and a
 * rotating error variant (type / message / multi-KB stack). Defeats V8's
 * constant-folding on every dynamic field the encoder hot path touches.
 *
 * Cost target: a handful of register-bound integer ops per span plus a
 * fixed-size string-pool rotation. Anything fancier shows up in the
 * bench as setup overhead.
 *
 * @param {object[]} trace
 * @param {number} iteration current iteration index.
 */
function tickTrace (trace, iteration) {
  // Trace ID is shared across every span; rewriting it once propagates.
  writeIdLowBytes(trace[0].trace_id._buffer, iteration, 0)

  for (let i = 0; i < trace.length; i++) {
    const span = trace[i]
    // start nano-timestamp climbs each iteration so V8 can't const-fold
    // the uint64 path. The +4096 step is well above the IEEE-754 double's
    // ULP at the ~1.7e18 base (256 nanos -- below that the value rounds
    // back to its base), so every step is a distinct double; a real fix
    // for that precision loss needs the span carry a BigInt, scoped to
    // its own PR on the tracer side.
    span.start = span._baseStart + iteration * 4096
    // Duration jitter stays in the bottom 14 bits so the value never leaves
    // the uint32 wire band that production spans live in.
    span.duration = span._baseDuration + (iteration & 0x3FFF)

    // Bumping span_id's low half changes the bytes `_encodeId` reads on
    // every call. parent_id is a shared reference to the root's span_id
    // for most spans, so we only rewrite the unique buffer once per span.
    writeIdLowBytes(span.span_id._buffer, iteration, i)

    if (span._baseRowCount !== undefined) {
      // db.row_count is a metric; metrics encode as numbers, so jittering
      // the value drives both the encoder's number path and (for v0.4) the
      // float64 encoding the inherited base class still uses.
      span.metrics['db.row_count'] = span._baseRowCount + (iteration % 64)
    }
  }

  // Root server-span request shape rotates as a coherent unit: the
  // status, the URL, the resource, and the client IP all change together,
  // matching what one production request looks like across these fields.
  const root = trace[0]
  const reqVariant = REQUEST_VARIANTS[iteration % REQUEST_VARIANTS.length]
  root.resource = reqVariant.resource
  const rootMeta = root.meta
  rootMeta['http.url'] = reqVariant.url
  rootMeta['http.route'] = reqVariant.route
  rootMeta['http.status_code'] = reqVariant.status
  rootMeta['http.client_ip'] = reqVariant.clientIp
  rootMeta['network.client.ip'] = reqVariant.clientIp

  // Error variant rotates the type/message/stack together. The stack is
  // the multi-KB string the encoder either bypasses the cache for (v0.4)
  // or writes into `_stringBytes` per encode (v0.5), so rotating it is
  // the main signal-defeating change in tickTrace.
  const errorSpan = trace._errorSpan
  if (errorSpan !== undefined) {
    const errVariant = ERROR_VARIANTS[iteration % ERROR_VARIANTS.length]
    const errMeta = errorSpan.meta
    errMeta['error.type'] = errVariant.type
    errMeta['error.message'] = errVariant.message
    errMeta['error.stack'] = errVariant.stack
  }
}

/**
 * Rewrite the low 4 bytes of an 8-byte ID buffer. The top 4 bytes keep the
 * per-span seed so spans remain distinguishable on the wire; the low 4
 * bytes carry the iteration index XOR'd with a span-local mixer so two
 * spans never share the same low half on the same tick.
 *
 * @param {Uint8Array} buffer
 * @param {number} iteration
 * @param {number} mixer
 */
function writeIdLowBytes (buffer, iteration, mixer) {
  const v = (iteration ^ (mixer * 0x9E_37_79_B1)) >>> 0
  buffer[4] = (v >>> 24) & 0xFF
  buffer[5] = (v >>> 16) & 0xFF
  buffer[6] = (v >>> 8) & 0xFF
  buffer[7] = v & 0xFF
}

const EVENT_ATTRIBUTES_HTTP_OK = { attempt: 1, ratio: 0.5, ok: true, kind: 'http.client', codes: [200, 204] }
const EVENT_ATTRIBUTES_HTTP_ERR = { attempt: 2, ratio: 0.6, ok: false, kind: 'http.server', codes: [500, 503] }
const EVENT_ATTRIBUTES_DB = { attempt: 3, ratio: 0.7, ok: true, kind: 'db.query', codes: [42] }

const EVENT_TIME_BASE_OK = 1_715_926_535_897_000_000
const EVENT_TIME_BASE_ERR = 1_715_926_535_898_000_000
const EVENT_TIME_BASE_DB = 1_715_926_535_899_000_000

/**
 * `encoder.encode` consumes `span_events`: the legacy path stringifies them
 * into `meta.events` and clears the field; the native path mutates each
 * attribute primitive into a typed wrapper. The trace is reused across
 * iterations, so re-attach fresh events before every encode and step the
 * event timestamps so they don't const-fold either.
 *
 * @param {object[]} trace
 * @param {number} iteration
 */
function attachFreshEvents (trace, iteration) {
  // `+ iteration * 4096` steps each event time by ~4 microseconds, well
  // above the ~256-nano ULP of the double at this magnitude so every
  // encode sees a fresh number.
  const stepped = iteration * 4096
  const okTime = EVENT_TIME_BASE_OK + stepped
  const errTime = EVENT_TIME_BASE_ERR + stepped
  const dbTime = EVENT_TIME_BASE_DB + stepped
  for (const span of trace) {
    span.span_events = [
      { name: 'http.attempt', time_unix_nano: okTime, attributes: { ...EVENT_ATTRIBUTES_HTTP_OK } },
      { name: 'http.failure', time_unix_nano: errTime, attributes: { ...EVENT_ATTRIBUTES_HTTP_ERR } },
      { name: 'db.query', time_unix_nano: dbTime, attributes: { ...EVENT_ATTRIBUTES_DB } },
    ]
  }
}

module.exports = { buildTrace, tickTrace, attachFreshEvents }
