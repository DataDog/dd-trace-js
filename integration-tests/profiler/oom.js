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

// Runner expects child process to send a port
process.send({ port: 0 })

const maxCount = process.argv[3] || 5
const sleepMs = process.argv[4] || 100

setTimeout(() => foo(10 * 1024 * 1024), sleepMs)
