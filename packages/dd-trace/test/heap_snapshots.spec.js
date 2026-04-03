'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { threadId } = require('node:worker_threads')

const { describe, it } = require('mocha')

require('./setup/core')
const { start } = require('../src/heap_snapshots')

const destination = mkdtempSync(join(tmpdir(), 'dd-trace-heap-snapshot-'))

describe('Heap Snapshots', () => {
  it('should take heap snapshots over time', async () => {
    // Keep process alive since `start` uses an unref timer.
    const interval = setInterval(() => {}, 1000)

    await start({
      heapSnapshot: {
        count: 3,
        destination,
        interval: 1,
      },
    })

    clearInterval(interval)

    const pattern = new RegExp(`^Heap-\\d{8}-\\d{6}-${process.pid}-${threadId}\\.heapsnapshot$`)
    const files = readdirSync(destination)

    assert.strictEqual(files.length, 3)
    assert.match(files[0], pattern)
    assert.match(files[1], pattern)
  })
})
