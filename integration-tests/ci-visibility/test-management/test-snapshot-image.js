'use strict'

const { describe, it, expect } = globalThis.expect ? globalThis : require('@jest/globals')

const { toMatchImageSnapshot } = require('jest-image-snapshot')

expect.extend({ toMatchImageSnapshot })

let retryCounter = 0
describe('snapshot', () => {
  if (process.env.MIXED_SNAPSHOT_SUITE) {
    it.concurrent('concurrent passing sibling', () => {
      expect(true).toBe(true)
    })
  }

  it('can match', () => {
    // This is a base64 encoded 1x1 transparent PNG image with correct CRC32 checksums
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
    const img = Buffer.from(b64, 'base64')

    const b64Wrong = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    const wrongImage = Buffer.from(b64Wrong, 'base64') // Different 1x1 image

    if (++retryCounter > 2) {
      expect(img).toMatchImageSnapshot()
    } else {
      expect(wrongImage).toMatchImageSnapshot()
    }
  })
})
