#!/usr/bin/env node
'use strict'

// Runs ./native-span-perf.js 2N times, alternating
// DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1 / =0, parses the per-period
// "<count>: <rps> req/s" lines emitted on stderr, and reports per-period
// throughput averages, the overhead of the native path vs. the baseline,
// and the stddev of that overhead across pairs.
//
// Usage: node ./perf-agg.js [N] [C]   (defaults: N = 5, C = 1)
//   N = number of pairs total
//   C = number of pairs to run concurrently

const { spawn } = require('node:child_process')
const path = require('node:path')

const N = Number.parseInt(process.argv[2] ?? '5', 10)
if (!Number.isInteger(N) || N < 1) {
  console.error(`invalid N: ${process.argv[2]}`)
  process.exit(1)
}
const C = Number.parseInt(process.argv[3] ?? '1', 10)
if (!Number.isInteger(C) || C < 1) {
  console.error(`invalid C: ${process.argv[3]}`)
  process.exit(1)
}

const SCRIPT = path.join(__dirname, 'native-span-perf.js')
const PERIOD_RE = /^(\d+):\s+(\d+)\s+req\/s/
const BASE_PORT = 18126

/**
 * @param {boolean} enabled
 * @param {number} slot
 * @returns {Promise<Record<string, number>>}
 */
function runOne (enabled, slot) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED: enabled ? '1' : '0',
      DD_SERVICE: enabled ? 'native_span_perf_wasm' : 'native_span_perf_no_wasm',
      PORT: String(BASE_PORT + slot * 2 + (enabled ? 0 : 1))
    }
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    /** @type {Record<string, number>} */
    const periods = {}
    let out = ''
    let buf = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      buf += chunk
      out += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const m = line.match(PERIOD_RE)
        if (m) periods[m[1]] = Number.parseInt(m[2], 10)
      }
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`native-span-perf.js exited with code ${code}:\n\n\t${out}`))
      else resolve(periods)
    })
  })
}

/** @param {number[]} arr */
function mean (arr) {
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

/** @param {number[]} arr */
function stddev (arr) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  let s = 0
  for (const v of arr) s += (v - m) ** 2
  return Math.sqrt(s / (arr.length - 1))
}

async function main () {
  /** @type {Array<{enabled: Record<string, number>, disabled: Record<string, number>}>} */
  const runs = []
  for (let i = 0; i < N; i += C) {
    const batch = Math.min(C, N - i)
    process.stderr.write(`pairs ${i + 1}-${i + batch}/${N} (concurrency=${batch}) ... `)
    const results = await Promise.all(
      Array.from({ length: batch }, async (_, slot) => {
        const [enabled, disabled] = await Promise.all([runOne(true, slot), runOne(false, slot)])
        return { enabled, disabled }
      })
    )
    process.stderr.write('done\n')
    runs.push(...results)
  }

  const periodKeys = Object.keys(runs[0].enabled)
    .filter(k => runs.every(r => k in r.enabled && k in r.disabled))
    .sort((a, b) => Number(a) - Number(b))

  const colHeaders = ['period', 'avg_native_rps', 'avg_baseline_rps', 'overhead_%', 'stddev_overhead_%']
  const rows = [colHeaders]
  /** @type {number[]} */
  const allOverheads = []

  for (const p of periodKeys) {
    const enabledVals = runs.map(r => r.enabled[p])
    const disabledVals = runs.map(r => r.disabled[p])
    const overheads = runs.map(r => (r.disabled[p] - r.enabled[p]) / r.disabled[p] * 100)
    allOverheads.push(...overheads)
    rows.push([
      p,
      mean(enabledVals).toFixed(1),
      mean(disabledVals).toFixed(1),
      mean(overheads).toFixed(2),
      stddev(overheads).toFixed(2)
    ])
  }

  rows.push([
    'overall',
    '',
    '',
    mean(allOverheads).toFixed(2),
    stddev(allOverheads).toFixed(2)
  ])

  const widths = colHeaders.map((_, c) => Math.max(...rows.map(r => String(r[c]).length)))
  for (const r of rows) {
    console.log(r.map((v, c) => String(v).padStart(widths[c])).join('  '))
  }

  console.log()
  console.log(`pairs: ${N}   overhead = (baseline_rps - native_rps) / baseline_rps * 100   (positive = native is slower)`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
