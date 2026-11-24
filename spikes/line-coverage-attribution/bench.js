'use strict'
// ns per context check at function entry. Usage: node [tier flags] bench.js N REPS
const { AsyncLocalStorage } = require('async_hooks')
const { storage } = require('../../packages/datadog-core/src/storage.js')
const st = storage('legacy')
const raw = new AsyncLocalStorage()
const N = +process.argv[2] || 1e7
const REPS = +process.argv[3] || 11
let last; let switches = 0
function plain (x) { return (x + 1) | 0 }
function ddHandle (x) { const s = st.getHandle(); if (s !== last) { last = s; switches++ } return (x + 1) | 0 }
function ddStore (x) { const s = st.getStore(); if (s !== last) { last = s; switches++ } return (x + 1) | 0 }
function rawStore (x) { const s = raw.getStore(); if (s !== last) { last = s; switches++ } return (x + 1) | 0 }
// a separate loop per variant keeps each call site monomorphic
function loopPlain () { let a = 0; for (let i = 0; i < N; i++) a = plain(a); return a }
function loopDdHandle () { let a = 0; for (let i = 0; i < N; i++) a = ddHandle(a); return a }
function loopDdStore () { let a = 0; for (let i = 0; i < N; i++) a = ddStore(a); return a }
function loopRawStore () { let a = 0; for (let i = 0; i < N; i++) a = rawStore(a); return a }
const variants = { plain: loopPlain, ddHandle: loopDdHandle, ddStore: loopDdStore, rawStore: loopRawStore }
const times = Object.fromEntries(Object.keys(variants).map(k => [k, []]))
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
st.run({ test: 1 }, () => raw.run({ test: 1 }, () => {
  for (let r = 0; r < REPS + 2; r++) {
    const keys = Object.keys(variants).sort(() => Math.random() - 0.5)
    for (const k of keys) {
      const t0 = process.hrtime.bigint(); variants[k](); const dt = Number(process.hrtime.bigint() - t0)
      if (r >= 2) times[k].push(dt / N)
    }
  }
}))
const base = median(times.plain)
const out = { node: process.version, plainNs: +base.toFixed(2) }
for (const k of ['ddHandle', 'ddStore', 'rawStore']) {
  const d = times[k].map((t, i) => t - times.plain[i]).sort((x, y) => x - y)
  out[k] = `${(median(times[k]) - base).toFixed(2)} [${d[1].toFixed(2)}..${d[d.length - 2].toFixed(2)}]`
}
out.switches = switches
console.log(JSON.stringify(out))
