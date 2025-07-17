'use strict'

/* eslint-disable no-console */

const tracer = require('dd-trace').init()

const { Worker, isMainThread, threadId } = require('worker_threads')

const nworkers = Number(process.argv[2] || 0)
const workerMaxOldGenerationSizeMb = process.argv[3]
const maxCount = process.argv[4] || 12
const sleepMs = process.argv[5] || 50
const sizeQuantum = process.argv[6] || 5 * 1024 * 1024

console.log(`${isMainThread ? 'Main thread' : `Worker ${threadId}`}: \
nworkers=${nworkers} workerMaxOldGenerationSizeMb=${workerMaxOldGenerationSizeMb} \
maxCount=${maxCount} sleepMs=${sleepMs} sizeQuantum=${sizeQuantum}`)

if (isMainThread) {
  for (let i = 0; i < nworkers; i++) {
    const worker = new Worker(__filename,
      {
        argv: [0, ...process.argv.slice(3)],
        ...(workerMaxOldGenerationSizeMb ? { resourceLimits: { maxOldGenerationSizeMb: 50 } } : {})
      })
    const threadId = worker.threadId
    worker
      .on('error', (err) => { console.log(`Worker ${threadId} error: ${err}`) })
      .on('exit', (code) => { console.log(`Worker ${threadId} exit: ${code}`) })
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

tracer.profilerStarted().then(
  () => {
    setTimeout(() => foo(sizeQuantum), sleepMs)
  }
)
