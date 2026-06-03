#!/usr/bin/env node

'use strict'

/* eslint-disable no-console */

// Local overview collector. For every variant of every bench it runs sirun a few
// times, computes the per-iteration wall.time mean + stddev from sirun's raw
// `iterations` array (wall.time is microseconds), reads the startup-share the
// guard writes in report mode, and writes a markdown table. Numbers are local
// (unpinned macOS) and meant as an overview, not the CI gate. Re-run with:
//   node collect-overview.js

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const DIR = __dirname
const SAMPLES = 6 // sirun iterations per variant for the overview (not the configured count)
const TIMEOUT_MS = 90_000
// Optional comma-separated dir filter (argv[2]); when set, write to a scratch
// file so a partial run does not clobber the committed overview.
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null
const OUT = only
  ? path.join(require('os').tmpdir(), 'overview-test.md')
  : path.join(DIR, 'benchmark-overview.md')
const SG_FILE = path.join(require('os').tmpdir(), 'sg-overview.txt')

// Curated per-bench judgment the run cannot measure.
const HIGH_MEANING = new Set([
  'shimmer-runtime', 'shimmer-startup', 'scope', 'id', 'spans', 'encoding',
  'exporting-pipeline', 'propagation', 'async_hooks', 'url', 'startup', 'fs',
])
const LOW_MEANING = new Set(['plugin-dns'])

const CRITICAL_PATH = new Set([
  'shimmer-runtime', 'shimmer-startup', 'scope', 'id', 'spans', 'encoding',
  'exporting-pipeline', 'propagation', 'async_hooks', 'startup',
])
const LIVE = new Set(['appsec', 'appsec-iast', 'plugin-http', 'plugin-net'])
const BACKGROUND = new Set(['runtime-metrics', 'profiler', 'log', 'llmobs', 'debugger'])

function meaningOf (name) {
  if (HIGH_MEANING.has(name)) return 'high'
  if (LOW_MEANING.has(name)) return 'low'
  return 'medium'
}

function categoryOf (name) {
  if (CRITICAL_PATH.has(name)) return 'critical-path'
  if (LIVE.has(name)) return 'live'
  if (BACKGROUND.has(name)) return 'background'
  return 'real-world-plugin'
}

function innerCount (env = {}) {
  return env.COUNT || env.ITERATIONS || env.QUERIES || (env.REQS ? `${env.REQS} reqs` : '-')
}

function stats (times) {
  const n = times.length
  const mean = times.reduce((a, b) => a + b, 0) / n
  const variance = n > 1 ? times.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0
  const stddevPct = mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100
  return { mean, stddevPct }
}

const benches = fs.readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(DIR, d.name, 'meta.json')))
  .map((d) => d.name)
  .sort()

fs.writeFileSync(OUT,
  '# sirun benchmark overview\n\n' +
  `Local macOS, ${SAMPLES} samples/variant (overview-grade, not the CI gate). ` +
  'wall.time is microseconds in sirun; reported per-iteration in ms. ' +
  '"total" = mean x configured iterations. "startup%" = load+setup share from the guard.\n\n' +
  'Live client/server benches (appsec, appsec-iast, http, net, debugger) are network/scheduler ' +
  'noisy locally, so their stddev here is not meaningful -- CI with core pinning is authoritative. ' +
  'startup-time variants need /opt/insecure-bank-js (a CI-only clone) and show "error" locally.\n\n' +
  '| bench | variant | category | meaning | inner loop | iters | per-iter ms | stddev% | total s | startup% |\n' +
  '|---|---|---|---|---|---|---|---|---|---|\n')

for (const name of benches) {
  if (only && !only.has(name)) continue
  const benchDir = path.join(DIR, name)
  const meta = JSON.parse(fs.readFileSync(path.join(benchDir, 'meta.json'), 'utf8'))
  const configIters = meta.iterations || SAMPLES
  const overview = { ...meta, iterations: SAMPLES }
  const tmpMeta = path.join(benchDir, 'meta-overview.json')
  fs.writeFileSync(tmpMeta, JSON.stringify(overview))

  const variants = meta.variants ? Object.keys(meta.variants) : ['(default)']
  for (const variant of variants) {
    const env = {
      ...process.env,
      SIRUN_VARIANT: variant,
      DD_TRACE_STARTUP_LOGS: 'false',
      STARTUP_GUARD_REPORT: SG_FILE,
    }
    try { fs.unlinkSync(SG_FILE) } catch {}

    const variantCfg = meta.variants?.[variant] || {}
    const inner = innerCount(variantCfg.env)
    let perIterMs = '-'
    let stddevPct = '-'
    let totalS = '-'
    let startupPct = '-'

    // sirun runs the variant's setup (client/server, service) when present, so
    // live benches measure too as long as the deps and ports are available.
    const res = spawnSync('sirun', ['meta-overview.json'],
      { cwd: benchDir, env, timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

    if (res.status === 0 && res.stdout) {
      try {
        const json = JSON.parse(res.stdout.trim().split('\n').pop())
        const times = (json.iterations || []).map((it) => it['wall.time']).filter((t) => typeof t === 'number')
        if (times.length) {
          const { mean, stddevPct: sd } = stats(times)
          perIterMs = (mean / 1000).toFixed(1)
          stddevPct = sd.toFixed(1)
          totalS = ((mean / 1e6) * configIters).toFixed(0)
        }
      } catch { perIterMs = 'parse-err' }
    } else {
      perIterMs = res.signal === 'SIGTERM' ? 'timeout' : 'error'
    }

    try { startupPct = (Number(fs.readFileSync(SG_FILE, 'utf8')) * 100).toFixed(1) } catch {}

    fs.appendFileSync(OUT,
      `| ${name} | ${variant} | ${categoryOf(name)} | ${meaningOf(name)} | ${inner} | ` +
      `${configIters} | ${perIterMs} | ${stddevPct} | ${totalS} | ${startupPct} |\n`)
    console.log(`${name}/${variant} ${perIterMs}ms sd=${stddevPct}% ${totalS}s start=${startupPct}%`)
  }

  try { fs.unlinkSync(tmpMeta) } catch {}
}

console.log(`\nWrote ${OUT}`)
