'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')

const { PNG } = require('../../../../vendor/node_modules/pngjs')

describe('WebdriverIO WebAssembly video worker', () => {
  let directory

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dd-trace-video-worker-test-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function encode (images) {
    for (let frame = 0; frame < images.length; frame++) {
      writeFileSync(join(directory, `0-${frame}.png`), images[frame])
    }
    const filePath = join(directory, 'video.webm')
    return new Promise((resolve, reject) => {
      const worker = new Worker(require.resolve('../../../datadog-plugin-mocha/src/webdriverio-video-worker'), {
        execArgv: [],
        // Prove the encoder does not require FFmpeg, a PATH, or tracer preloads.
        env: {},
        workerData: { directory, index: 0, frames: images.length, filePath },
      })
      let error
      worker.once('error', value => { error = value })
      worker.once('exit', code => {
        if (error) return reject(error)
        assert.strictEqual(code, 0)
        resolve(readFileSync(filePath))
      })
    })
  }

  it('encodes odd dimensions and a resized viewport without an executable or browser globals', async () => {
    const video = await encode([
      PNG.sync.write(new PNG({ width: 3, height: 5 })),
      PNG.sync.write(new PNG({ width: 7, height: 3 })),
    ])
    assert.deepStrictEqual([...video.subarray(0, 4)], [26, 69, 223, 163])
    assert.ok(video.includes(Buffer.from('V_VP8')))
  })

  it('accepts the 16 megapixel boundary and downscales before encoding', async () => {
    const video = await encode([PNG.sync.write(new PNG({ width: 4096, height: 4096 }))])
    assert.ok(video.byteLength > 0)
  })

  it('rejects the first oversized screenshot before decoding its compressed pixels', async () => {
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    png.writeUInt32BE(16 * 1024 * 1024 + 1, 16)
    await assert.rejects(encode([png]), { message: 'WebdriverIO video frame exceeds the 16 megapixel limit' })
  })

  it('reports corrupt PNG input through the worker error boundary', async () => {
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    png[0] = 0
    await assert.rejects(encode([png]), { message: 'unrecognised content at end of stream' })
  })
})
