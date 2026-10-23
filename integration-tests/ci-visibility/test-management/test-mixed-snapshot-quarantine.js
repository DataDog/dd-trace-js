'use strict'

// Jest 24's resolver does not recognize the node: prefix.
const path = require('path')

const { toMatchImageSnapshot } = require('jest-image-snapshot')

const { describe, it, expect } = globalThis.expect ? globalThis : require('@jest/globals')

expect.extend({ toMatchImageSnapshot })

describe('mixed snapshots', () => {
  it('quarantined snapshot', () => {
    expect('received').toMatchSnapshot()
  })

  it('quarantined unused snapshot', () => {
    expect(true).toBe(true)
  })

  it('ordinary snapshot', () => {
    if (process.env.SKIP_ORDINARY_SNAPSHOT) return
    expect(process.env.FAIL_ORDINARY_SNAPSHOT ? 'received' : 'stored').toMatchSnapshot()
  })

  it('quarantined unused snapshot: ordinary', () => {
    if (process.env.SKIP_ORDINARY_SNAPSHOT || process.env.SKIP_PREFIXED_SNAPSHOT) return
    expect('stored').toMatchSnapshot()
    expect('stored').toMatchSnapshot('response')
  })

  if (process.env.MIXED_SNAPSHOT_SUITE) {
    it.concurrent('concurrent sibling', () => {
      if (process.env.FAIL_CONCURRENT_SNAPSHOT) {
        const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
        expect(Buffer.from(b64, 'base64')).toMatchImageSnapshot({
          customSnapshotsDir: path.join(__dirname, '__image_snapshots__'),
          customSnapshotIdentifier: 'test-snapshot-image-js-snapshot-can-match-1-snap',
        })
      } else {
        expect(true).toBe(true)
      }
    })
  }
})
