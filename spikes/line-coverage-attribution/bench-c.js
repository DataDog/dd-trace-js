'use strict'
// ns per check for C (addon, CPED identity) against B (ALS getStore identity), same harness as bench.js.
const { AsyncLocalStorage } = require('async_hooks')
const cped = require('./build/Release/cped.node')
const raw = new AsyncLocalStorage()
const N = +process.argv[2] || 1e7
const REPS = +process.argv[3] || 11
let last; let switches = 0
function plain (x) { return (x + 1) | 0 }
function rawStore (x) { const s = raw.getStore(); if (s !== last) { last = s; switches++ } return (x + 1) | 0 }
function addon (x) { if (cped.changed() === 1) switches++; return (x + 1) | 0 }
function loopPlain () { let a = 0; for (let i = 0; i < N; i++) a = plain(a); return a }
function loopRawStore () { let a = 0; for (let i = 0; i < N; i++) a = rawStore(a); return a }
function loopAddon () { let a = 0; for (let i = 0; i < N; i++) a = addon(a); return a }
const variants = { plain: loopPlain, rawStore: loopRawStore, addon: loopAddon }
const times = Object.fromEntries(Object.keys(variants).map(k => [k, []]))
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
raw.run({ test: 1 }, () => {
  for (let r = 0; r < REPS + 2; r++) {
    const keys = Object.keys(variants).sort(() => Math.random() - 0.5)
    for (const k of keys) {
      const t0 = process.hrtime.bigint(); variants[k](); const dt = Number(process.hrtime.bigint() - t0)
      if (r >= 2) times[k].push(dt / N)
    }
  }
})
const base = median(times.plain)
const out = { node: process.version, plainNs: +base.toFixed(2) }
for (const k of ['rawStore', 'addon']) {
  const d = times[k].map((t, i) => t - times.plain[i]).sort((x, y) => x - y)
  out[k] = `${(median(times[k]) - base).toFixed(2)} [${d[1].toFixed(2)}..${d[d.length - 2].toFixed(2)}]`
}
const [fast, slow] = cped.counts()
out.fastShare = +(fast / (fast + slow)).toFixed(3)
out.switches = switches
console.log(JSON.stringify(out))
