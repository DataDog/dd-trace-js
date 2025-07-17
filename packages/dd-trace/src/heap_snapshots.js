'use strict'

const { join } = require('path')
const { setImmediate, setTimeout } = require('timers/promises')
const { format } = require('util')
const { writeHeapSnapshot } = require('v8')
const { threadId } = require('worker_threads')
const log = require('./log')

async function scheduleSnapshot (config, total) {
  if (total > config.heapSnapshot.count) return

  await setTimeout(config.heapSnapshot.interval * 1000, null, { ref: false })
  await clearMemory()
  writeHeapSnapshot(getName(config.heapSnapshot.destination))
  await scheduleSnapshot(config, total + 1)
}

async function clearMemory () {
  if (!globalThis.gc) return
  globalThis.gc()
  await setImmediate()
  globalThis.gc() // Run full GC a second time for anything missed in first GC.
}

function pad (value) {
  return String(value).padStart(2, 0)
}

function getName (destination) {
  const date = new Date()
  const filename = format(
    'Heap-%s%s%s-%s%s%s-%s-%s.heapsnapshot',
    date.getFullYear(),
    pad(date.getMonth()),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    process.pid,
    threadId
  )

  return join(destination, filename)
}

module.exports = {
  async start (config) {
    const destination = config.heapSnapshot.destination

    try {
      await scheduleSnapshot(config, 1)
      log.debug('Wrote heap snapshots to %s.', destination)
    } catch (e) {
      log.error('Failed to write heap snapshots to %s.', destination, e)
    }
  }
}
