'use strict'

// Helper script forked by allocation_worker.spec.js.
// Runs in a separate process so the heap snapshot covers only
// this lightweight process, not the full mocha test runner.

const path = require('node:path')
const { Worker } = require('node:worker_threads')

const workerPath = path.join(
  __dirname, '../../../src/profiling/profilers/allocation/worker.js'
)

const command = process.argv[2]

function spawnWorker () {
  const worker = new Worker(workerPath)
  const pending = new Map()
  const received = []

  worker.on('message', (msg) => {
    const waiters = pending.get(msg.type)
    if (waiters?.length > 0) {
      waiters.shift()(msg)
    } else {
      received.push(msg)
    }
  })

  return {
    waitForMessage (type) {
      const idx = received.findIndex(m => m.type === type)
      if (idx !== -1) {
        return Promise.resolve(received.splice(idx, 1)[0])
      }
      return new Promise((resolve) => {
        if (!pending.has(type)) pending.set(type, [])
        pending.get(type).push(resolve)
      })
    },
    send (msg) { worker.postMessage(msg) },
    worker,
  }
}

function output (obj) {
  process.stdout.write(JSON.stringify(obj))
}

async function run () {
  switch (command) {
    case 'ready': {
      const ctx = spawnWorker()
      const msg = await ctx.waitForMessage('ready')
      output({ firstMessage: msg.type })
      ctx.send({ type: 'shutdown' })
      await ctx.waitForMessage('error').catch(() => {})
      break
    }

    case 'tracking-started': {
      const ctx = spawnWorker()
      await ctx.waitForMessage('ready')
      ctx.send({ type: 'start-tracking' })
      const msg = await ctx.waitForMessage('tracking-started')
      output({ message: msg.type })
      ctx.send({ type: 'shutdown' })
      break
    }

    case 'profile': {
      const ctx = spawnWorker()
      await ctx.waitForMessage('ready')
      ctx.send({ type: 'start-tracking' })
      await ctx.waitForMessage('tracking-started')

      // Allocate objects retained until after profile
      const retained = []
      for (let i = 0; i < 1000; i++) {
        retained.push({ i, data: new Array(10) })
      }

      const now = Date.now()
      ctx.send({
        type: 'stop-and-build-profile',
        startDate: now - 1000,
        endDate: now,
      })

      const msg = await ctx.waitForMessage('profile-result')
      // Keep retained alive
      if (retained.length === 0) throw new Error('unreachable')
      output({
        buffer: Buffer.from(msg.buffer).toString('base64'),
      })
      ctx.send({ type: 'shutdown' })
      break
    }

    case 'timeline-in-pprof': {
      const ctx = spawnWorker()
      await ctx.waitForMessage('ready')
      ctx.send({ type: 'start-tracking' })
      await ctx.waitForMessage('tracking-started')

      const retained = []
      for (let i = 0; i < 1000; i++) {
        retained.push({ i, data: new Array(10) })
      }

      // Give V8 time to emit timeline events (heapStatsUpdate + lastSeenObjectId)
      await new Promise(resolve => setTimeout(resolve, 200))

      const now = Date.now()
      ctx.send({
        type: 'stop-and-build-profile',
        startDate: now - 1000,
        endDate: now,
      })

      const msg = await ctx.waitForMessage('profile-result')
      if (retained.length === 0) throw new Error('unreachable')
      output({
        buffer: Buffer.from(msg.buffer).toString('base64'),
      })
      ctx.send({ type: 'shutdown' })
      break
    }

    case 'empty-profile': {
      const ctx = spawnWorker()
      await ctx.waitForMessage('ready')
      ctx.send({ type: 'start-tracking' })
      await ctx.waitForMessage('tracking-started')

      // Stop immediately without allocating
      const now = Date.now()
      ctx.send({
        type: 'stop-and-build-profile',
        startDate: now - 100,
        endDate: now,
      })

      const msg = await ctx.waitForMessage('profile-result')
      output({
        buffer: Buffer.from(msg.buffer).toString('base64'),
      })
      ctx.send({ type: 'shutdown' })
      break
    }

    case 'shutdown': {
      const ctx = spawnWorker()
      await ctx.waitForMessage('ready')

      const exitPromise = new Promise((resolve) => {
        ctx.worker.on('exit', (code) => resolve(code))
      })

      ctx.send({ type: 'shutdown' })
      const exitCode = await exitPromise
      output({ exitCode })
      break
    }

    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

run().catch((err) => {
  process.stderr.write(err.stack || err.message)
  process.exit(1)
})
