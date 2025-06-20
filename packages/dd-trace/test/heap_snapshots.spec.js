'use strict'

require('./setup/tap')

const { mkdtempSync, readdirSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { start } = require('../src/heap_snapshots')

const folder = mkdtempSync(join(tmpdir(), 'dd-trace-heap-snapshot-'))

describe('Heap Snapshots', () => {
  it('should take heap snapshots over time', async () => {
    // Keep process alive since `start` uses an unref timer.
    const interval = setInterval(() => {}, 100)

    await start({
      heapSnapshot: {
        count: 2,
        folder,
        interval: 1
      }
    })

    clearInterval(interval)

    const pattern = /^Heap-\d{8}-\d{6}-\d+-\d+\.heapsnapshot$/
    const files = readdirSync(folder)

    expect(files).to.have.length(2)
    expect(files[0]).to.match(pattern)
    expect(files[1]).to.match(pattern)
  })
})
