'use strict'

require('./setup/tap')

const { mkdtempSync, readdirSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { threadId } = require('worker_threads')
const { start } = require('../src/heap_snapshots')

const destination = mkdtempSync(join(tmpdir(), 'dd-trace-heap-snapshot-'))

describe('Heap Snapshots', () => {
  it('should take heap snapshots over time', async () => {
    // Keep process alive since `start` uses an unref timer.
    const interval = setInterval(() => {}, 1000)

    await start({
      heapSnapshot: {
        enabled: true,
        destination,
        interval: 1
      }
    })

    clearInterval(interval)

    const pattern = new RegExp(`^Heap-\\d{8}-\\d{6}-${process.pid}-${threadId}\\.heapsnapshot$`)
    const files = readdirSync(destination)

    expect(files).to.have.length(3)
    expect(files[0]).to.match(pattern)
    expect(files[1]).to.match(pattern)
  })
})
