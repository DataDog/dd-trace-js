'use strict'

// Runs the shared test app twice — once on the baseline `Span`, once with
// `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1` — against the capture server, and compares
// what the two exported.
//
// The two run as separate process invocations, so ids and timestamps never match
// across runs; the comparison is structural. Deterministic id seeding across both
// implementations was considered and rejected: it buys nothing the structural
// comparison does not already answer, for real plumbing cost.
//
//   node benchmark/sirun/native-spans/parity.js

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { join } = require('node:path')

const { ROUTES } = require('./app')
const { startCaptureServer } = require('./capture-server')

const WORKER_PATH = join(__dirname, 'parity-worker.js')

// Both runs listen here, sequentially. An ephemeral port per run would put a
// different `http.url` and a different set of port metrics on every span, and the
// two runs would never be comparable on those fields at all.
const APP_PORT = Number(process.env.PARITY_APP_PORT) || 31_337

// The wire format both sides speak. Pinned rather than left to the environment, so a
// stray `DD_TRACE_AGENT_PROTOCOL_VERSION` cannot point the baseline at a format the
// capture server does not accept.
const PROTOCOL = '0.4'

/**
 * Tag keys whose values cannot match across two processes, or that this PoC
 * deliberately does not produce.
 *
 * Volatile by nature: ids, timestamps, per-process identity.
 * Out of scope: everything sampling-related, since "sampling is ignored, every span
 * that completes is exported" is a stated non-goal — the native path emits no
 * sampling priority, decision or rate.
 */
const EXCLUDED_TAGS = new Set([
  // Volatile across two processes.
  '_dd.p.tid',
  'runtime-id',
  'process_id',
  '_dd.rc.client_id',
  // Sampling: not replicated at all.
  '_sampling_priority_v1',
  '_dd.p.dm',
  '_dd.p.ksr',
  '_dd.p.ts',
  '_dd.agent_psr',
  '_dd.rule_psr',
  '_dd.limit_psr',
  '_dd.tracer_kr',
  // Git metadata tagging and process tags, both explicitly out of scope for the
  // native `process` stage.
  '_dd.git.commit.sha',
  '_dd.git.repository_url',
  '_dd.tags.process',
])

/**
 * Differences that follow directly from a stated non-goal, with the mechanism named.
 * Reported, not counted as failures — the point of the harness is to surface the
 * unexplained divergence.
 */
const EXPECTED_DIFFERENCES = [
  {
    reason: 'tag read-back: `addResourceTag` re-reads `resource.name` and `http.route` off the ' +
      'span context, and a native context has no tag map to read from, so the route never joins ' +
      'the resource',
    matches: difference => / resource: baseline "\w+ \/.*", native "\w+"$/.test(difference),
  },
  {
    reason: 'no trace-level tag map: `_dd.p.tid` cannot ride the Datadog headers, so the callee ' +
      'reconstructs a 64-bit trace id from them while `traceparent` carries the full 128-bit one, ' +
      "and the tracer's own conflict detection records a `terminated_context` link",
    matches: difference => difference.includes('native-only key _dd.span_links') &&
      difference.includes('terminated_context'),
  },
  {
    reason: 'the client\'s ephemeral local port differs per run',
    matches: difference => difference.includes('metrics.tcp.local.port'),
  },
]

async function main () {
  const baseline = await collect(false)
  const native = await collect(true)

  const differences = []
  const expected = new Map()

  for (const difference of compare(baseline, native)) {
    const match = EXPECTED_DIFFERENCES.find(candidate => candidate.matches(difference))
    if (match === undefined) {
      differences.push(difference)
    } else {
      expected.set(match.reason, (expected.get(match.reason) ?? 0) + 1)
    }
  }

  process.stdout.write(`baseline chunks: ${baseline.length}, native chunks: ${native.length}\n`)
  for (const [index, chunk] of baseline.entries()) {
    process.stdout.write(`  baseline[${index}]: ${chunk.map(span => span.name).join(', ')}\n`)
  }
  for (const [index, chunk] of native.entries()) {
    process.stdout.write(`  native[${index}]:   ${chunk.map(span => span.name).join(', ')}\n`)
  }

  if (expected.size > 0) {
    process.stdout.write('Expected differences (stated non-goals):\n')
    for (const [reason, count] of expected) {
      process.stdout.write(`  ${count}x ${reason}\n`)
    }
  }

  if (differences.length === 0) {
    process.stdout.write('\nPARITY OK — no unexplained differences\n')
    return
  }

  process.stdout.write(`\nPARITY FAILED (${differences.length} unexplained difference(s))\n`)
  for (const difference of differences) {
    process.stdout.write(`  ${difference}\n`)
  }
  process.exitCode = 1
}

/**
 * Drive every route in a child process and return the chunks it exported, sorted
 * into a comparable order.
 *
 * @param {boolean} native
 * @returns {Promise<import('./capture-server').CapturedSpan[][]>}
 */
async function collect (native) {
  const capture = await startCaptureServer()

  await new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, {
      env: {
        ...process.env,
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${capture.port}`,
        DD_TRACE_AGENT_PROTOCOL_VERSION: PROTOCOL,
        DD_TRACE_EXPERIMENTAL_NATIVE_SPANS: native ? '1' : '0',
        PARITY_APP_PORT: String(APP_PORT),
        DD_SERVICE: 'native-spans-parity',
        DD_ENV: 'parity',
        DD_VERSION: '1.0.0',
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_TRACE_SAMPLE_RATE: '1',
        // Instrumented shells export these; with `OTEL_TRACES_EXPORTER=otlp` the
        // tracer routes spans past the capture server and nothing is asserted.
        // `none` needs the explicit `DD_TRACE_ENABLED` above it: unset, an
        // `OTEL_TRACES_EXPORTER=none` selects the noop tracer outright
        // (`packages/dd-trace/src/index.js`).
        DD_TRACE_ENABLED: 'true',
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_METRICS_EXPORTER: 'none',
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    child.once('error', reject)
    child.once('exit', code => {
      code === 0 ? resolve() : reject(new Error(`parity worker exited with ${code}`))
    })
  })

  // The native path defers the HTTP PUT to a worker thread, so the last payload can
  // still be in flight when the child exits.
  await new Promise(resolve => setTimeout(resolve, 500))
  await capture.close()

  return sortChunks(capture.chunks)
}

/**
 * Chunks arrive in whatever order the two implementations flushed them, so key each
 * on its root span's resource — one per route — and sort spans within a chunk by
 * name then start time.
 *
 * @param {import('./capture-server').CapturedSpan[][]} chunks
 */
function sortChunks (chunks) {
  for (const chunk of chunks) {
    chunk.sort((left, right) => left.name.localeCompare(right.name) || left.start - right.start)
  }
  return chunks.slice().sort((left, right) => chunkKey(left).localeCompare(chunkKey(right)))
}

/**
 * `http.route` is in the key because the native path's framework spans carry a
 * resource of just `GET` (see `EXPECTED_DIFFERENCES`), so name + resource alone ties
 * between two routes with the same span shape and the chunks pair up wrongly.
 *
 * @param {import('./capture-server').CapturedSpan[]} chunk
 * @returns {string}
 */
function chunkKey (chunk) {
  return chunk
    .map(span => `${span.name}|${span.resource}|${span.meta['http.route'] ?? ''}`)
    .sort()
    .join('/')
}

/**
 * @param {import('./capture-server').CapturedSpan[][]} baseline
 * @param {import('./capture-server').CapturedSpan[][]} native
 * @returns {string[]}
 */
function compare (baseline, native) {
  const differences = []

  if (baseline.length !== native.length) {
    differences.push(`chunk count: baseline ${baseline.length}, native ${native.length}`)
  }

  const parentOf = spans => {
    const byId = new Map(spans.map(span => [span.span_id, span]))
    return span => byId.get(span.parent_id)?.name ?? (span.parent_id === '0' ? '<root>' : '<missing>')
  }

  for (let index = 0; index < Math.min(baseline.length, native.length); index++) {
    const baselineChunk = baseline[index]
    const nativeChunk = native[index]
    const label = `chunk[${index}]`

    if (baselineChunk.length !== nativeChunk.length) {
      differences.push(`${label} span count: baseline ${baselineChunk.length}, native ${nativeChunk.length}`)
    }

    const baselineParent = parentOf(baselineChunk)
    const nativeParent = parentOf(nativeChunk)

    for (let spanIndex = 0; spanIndex < Math.min(baselineChunk.length, nativeChunk.length); spanIndex++) {
      const left = baselineChunk[spanIndex]
      const right = nativeChunk[spanIndex]
      const spanLabel = `${label}.span[${spanIndex}] (${left.name})`

      for (const field of ['name', 'resource', 'service', 'type', 'error']) {
        if (left[field] !== right[field]) {
          differences.push(`${spanLabel} ${field}: baseline ${JSON.stringify(left[field])}, ` +
            `native ${JSON.stringify(right[field])}`)
        }
      }

      if (baselineParent(left) !== nativeParent(right)) {
        differences.push(`${spanLabel} parent: baseline ${baselineParent(left)}, native ${nativeParent(right)}`)
      }

      differences.push(...compareTagMap(`${spanLabel} meta`, left.meta, right.meta))
      differences.push(...compareTagMap(`${spanLabel} metrics`, left.metrics, right.metrics))
    }
  }

  return differences
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} baseline
 * @param {Record<string, unknown>} native
 * @returns {string[]}
 */
function compareTagMap (label, baseline, native) {
  const differences = []
  const keys = new Set([...Object.keys(baseline), ...Object.keys(native)])

  for (const key of keys) {
    if (EXCLUDED_TAGS.has(key)) continue

    const inBaseline = key in baseline
    const inNative = key in native
    if (!inBaseline) {
      differences.push(`${label}: native-only key ${key}=${JSON.stringify(native[key])}`)
      continue
    }
    if (!inNative) {
      differences.push(`${label}: baseline-only key ${key}=${JSON.stringify(baseline[key])}`)
      continue
    }
    if (baseline[key] !== native[key]) {
      differences.push(`${label}.${key}: baseline ${JSON.stringify(baseline[key])}, ` +
        `native ${JSON.stringify(native[key])}`)
    }
  }

  return differences
}

assert.ok(ROUTES.length > 0, 'the shared app must expose at least one route')

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
