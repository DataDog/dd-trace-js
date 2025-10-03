'use strict'

const { toMatchImageSnapshot } = require('jest-image-snapshot')

expect.extend({ toMatchImageSnapshot })

let retryCounter = 0
describe('snapshot', () => {
  it('can match', () => {
    // This is a base64 encoded 1x1 transparent PNG image with correct CRC32 checksums
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
    const img = Buffer.from(b64, 'base64')

    retryCounter++
    if (retryCounter > 2) {
      expect(img).toMatchImageSnapshot()
    } else {
      expect('hello').toMatchImageSnapshot()
    }
  })
})
