'use strict'

const path = require('node:path')

const { toMatchImageSnapshot } = require('jest-image-snapshot')

const { describe, it, expect } = globalThis.expect ? globalThis : require('@jest/globals')

expect.extend({ toMatchImageSnapshot })

let startConcurrent, finishConcurrent
const serialStarted = new Promise(resolve => { startConcurrent = resolve })
const concurrentFinished = new Promise(resolve => { finishConcurrent = resolve })

describe('overlapping snapshots', () => {
  it('quarantined snapshot', async () => {
    startConcurrent()
    await concurrentFinished
    expect('received').toMatchSnapshot()
  })

  it.concurrent('ordinary concurrent image snapshot', async () => {
    await serialStarted
    try {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
      expect(Buffer.from(b64, 'base64')).toMatchImageSnapshot({
        customSnapshotsDir: path.join(__dirname, '__image_snapshots__'),
        customSnapshotIdentifier: 'test-snapshot-image-js-snapshot-can-match-1-snap',
      })
    } finally {
      finishConcurrent()
    }
  })
})
