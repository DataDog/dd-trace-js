'use strict'

const { format } = require('util')

async function scheduleSnapshot (config, total) {
  if (total > config.heapSnapshot.count) return

  const { setTimeout } = require('timers/promises')
  const { writeHeapSnapshot } = require('v8')

  await setTimeout(config.heapSnapshot.interval * 1000, null, { ref: false })
  await clearMemory()
  writeHeapSnapshot(getName(config.heapSnapshot.folder))
  await scheduleSnapshot(config, total + 1)
}

async function clearMemory () {
  const { setImmediate } = require('timers/promises')

  globalThis.gc()
  await setImmediate()
  globalThis.gc() // Run full GC a second time for anything missed in first GC.
}

function pad (value) {
  return String(value).padStart(2, 0)
}

function getName (folder) {
  const { threadId } = require('worker_threads')
  const { join } = require('path')
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

  return join(folder, filename)
}

module.exports = {
  async start (config) {
    if (config.heapSnapshot.count > 0 && globalThis.gc) {
      await scheduleSnapshot(config, 1)
    }
  }
}
