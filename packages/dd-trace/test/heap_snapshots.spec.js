'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha
const { mkdtempSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { threadId } = require('node:worker_threads')

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
