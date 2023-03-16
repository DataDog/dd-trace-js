'use strict'

require('dd-trace').init()

const { Worker, isMainThread } = require('node:worker_threads')

if (isMainThread) {
  const nworkers = Number(process.argv[2])
  const workers = []
  if (nworkers) {
    for (let i = 0; i < nworkers; i++) {
      workers.push(new Worker(__filename))
    }
  }
}

const leak = []
let count = 0

function foo (size) {
  count += 1
  const n = size / 8
  const x = []
  x.length = n
  for (let i = 0; i < n; i++) { x[i] = Math.random() }
  leak.push(x)

  if (count < maxCount) { setTimeout(() => foo(size), sleepMs) }
}

const maxCount = process.argv[3] || 12
const sleepMs = process.argv[4] || 50

setTimeout(() => foo(5 * 1024 * 1024), sleepMs)
