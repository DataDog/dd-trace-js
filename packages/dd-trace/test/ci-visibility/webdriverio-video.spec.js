'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const { dirname } = require('node:path')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')

describe('WebdriverIO video recording', () => {
  let clock
  let createVideo
  let browser
  let encode
  let probe
  let log
  let directories
  let recorders

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    directories = []
    recorders = []
    browser = Object.assign(new EventEmitter(), { takeScreenshot: sinon.stub().resolves(PNG) })
    probe = sinon.stub().returns({ status: 0 })
    encode = sinon.stub().callsFake((command, args, options, callback) => {
      callback()
    })
    log = { error: sinon.spy(), warn: sinon.spy() }
    createVideo = proxyquire('../../../datadog-plugin-mocha/src/webdriverio-video', {
      'node:child_process': { execFile: encode, spawnSync: probe },
      'node:fs': {
        mkdtempSync: prefix => {
          const directory = fs.mkdtempSync(prefix)
          directories.push(directory)
          return directory
        },
      },
      '../../dd-trace/src/log': log,
    })
  })

  afterEach(async () => {
    for (const recorder of recorders) recorder.finish(false, () => {}, () => {})
    await clock.tickAsync(5000)
    clock.restore()
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
  })

  function start () {
    const recorder = createVideo(browser)
    if (recorder) recorders.push(recorder)
    return recorder
  }

  it('captures commands and idle periods without recursively recording screenshots', async () => {
    const recorder = start()
    await clock.tickAsync(0)
    browser.emit('result', { command: 'takeScreenshot' })
    sinon.assert.calledOnce(browser.takeScreenshot)
    browser.emit('result', { command: 'elementClick' })
    browser.emit('result', { command: 'elementClick' })
    sinon.assert.calledTwice(browser.takeScreenshot)
    await clock.tickAsync(500)
    sinon.assert.calledThrice(browser.takeScreenshot)

    const upload = sinon.spy()
    const complete = sinon.spy()
    recorder.finish(true, upload, complete)
    await clock.tickAsync(0)
    sinon.assert.calledOnce(upload)
    sinon.assert.notCalled(complete)
    const [filePath, index, uploaded] = upload.firstCall.args
    assert.strictEqual(index, 0)
    assert.strictEqual(fs.readdirSync(dirname(filePath)).length, 4)
    assert.strictEqual(browser.listenerCount('result'), 0)
    assert.strictEqual(encode.firstCall.args[0], 'ffmpeg')
    assert.strictEqual(encode.firstCall.args[2].shell, undefined)
    assert.strictEqual(encode.firstCall.args[2].timeout, 30_000)
    uploaded()
    sinon.assert.calledOnceWithExactly(complete, 'uploaded')
    assert.strictEqual(fs.existsSync(dirname(filePath)), false)
    await clock.tickAsync(1000)
    assert.strictEqual(browser.takeScreenshot.callCount, 4)
  })

  it('discards passing and skipped attempts without encoding or upload', async () => {
    const recorder = start()
    const complete = sinon.spy()
    const upload = sinon.spy()
    recorder.finish(false, upload, complete)
    await clock.tickAsync(0)
    sinon.assert.calledOnceWithExactly(complete, undefined)
    sinon.assert.notCalled(encode)
    sinon.assert.notCalled(upload)
    assert.strictEqual(fs.existsSync(directories[0]), false)
    assert.strictEqual(browser.listenerCount('result'), 0)
  })

  it('keeps attempt files isolated while an earlier upload is pending', async () => {
    const first = start()
    const firstUpload = sinon.spy()
    first.finish(true, firstUpload, () => {})
    await clock.tickAsync(0)
    const second = start()
    second.finish(false, () => {}, () => {})
    await clock.tickAsync(0)
    assert.notStrictEqual(directories[0], directories[1])
    assert.strictEqual(fs.existsSync(directories[0]), true)
    assert.strictEqual(fs.existsSync(directories[1]), false)
    firstUpload.firstCall.args[2]()
    assert.strictEqual(fs.existsSync(directories[0]), false)
  })

  it('uploads each multiremote session and aggregates upload errors', async () => {
    browser.takeScreenshot.resolves([PNG, PNG])
    const recorder = start()
    const complete = sinon.spy()
    const upload = sinon.spy((filePath, index, callback) => callback(index ? new Error('upload failed') : undefined))
    recorder.finish(true, upload, complete)
    await clock.tickAsync(0)
    assert.deepStrictEqual(upload.args.map(args => args[1]), [0, 1])
    sinon.assert.calledTwice(encode)
    sinon.assert.calledOnceWithExactly(complete, 'error')
    assert.strictEqual(fs.existsSync(directories[0]), false)
  })

  it('captures mixed Classic and BiDi multiremote sessions using their own protocol', async () => {
    const classic = { takeScreenshot: sinon.stub().resolves(PNG) }
    const bidi = {
      isBidi: true,
      getWindowHandle: sinon.stub().resolves('window-1'),
      browsingContextCaptureScreenshot: sinon.stub().resolves({ data: PNG }),
      takeScreenshot: sinon.stub().throws(new Error('Classic screenshots are unavailable')),
    }
    Object.assign(browser, {
      isMultiremote: true,
      // Multiremote properties can be command wrappers, not the single-session boolean.
      isBidi: () => [false, true],
      instances: ['classic', 'bidi'],
      getInstance: name => name === 'classic' ? classic : bidi,
    })
    const recorder = start()
    const complete = sinon.spy()
    const upload = sinon.spy((filePath, index, callback) => callback())
    recorder.finish(true, upload, complete)
    await clock.tickAsync(0)
    sinon.assert.calledOnce(classic.takeScreenshot)
    sinon.assert.notCalled(bidi.takeScreenshot)
    sinon.assert.notCalled(browser.takeScreenshot)
    sinon.assert.calledOnceWithExactly(bidi.browsingContextCaptureScreenshot, {
      context: 'window-1', origin: 'viewport', format: { type: 'image/png' },
    })
    sinon.assert.calledTwice(upload)
    sinon.assert.calledOnceWithExactly(complete, 'uploaded')
  })

  it('does not start a late BiDi capture after its timeout', async () => {
    /** @type {((value: string) => void)|undefined} */
    let resolveContext
    Object.assign(browser, {
      isBidi: true,
      getWindowHandle: () => new Promise(resolve => { resolveContext = resolve }),
      browsingContextCaptureScreenshot: sinon.spy(),
    })
    const recorder = start()
    const complete = sinon.spy()
    recorder.finish(true, () => assert.fail('unexpected upload'), complete)
    await clock.tickAsync(5000)
    assert.ok(resolveContext)
    resolveContext('window-1')
    await clock.tickAsync(0)
    sinon.assert.notCalled(browser.browsingContextCaptureScreenshot)
    sinon.assert.calledOnceWithExactly(complete, 'error')
  })

  for (const bytes of [200 * 1024 * 1024, 200 * 1024 * 1024 + 1]) {
    it(`enforces the raw recording limit for ${bytes} bytes`, async () => {
      const frame = Buffer.alloc(bytes)
      Buffer.from(PNG, 'base64').copy(frame)
      browser.takeScreenshot.resolves(frame.toString('base64'))
      const recorder = start()
      const complete = sinon.spy()
      const upload = sinon.spy((filePath, index, callback) => callback())
      recorder.finish(true, upload, complete)
      await clock.tickAsync(0)
      const accepted = bytes === 200 * 1024 * 1024
      sinon.assert.calledOnceWithExactly(complete, accepted ? 'uploaded' : 'error')
      assert.strictEqual(upload.callCount, accepted ? 1 : 0)
      assert.strictEqual(fs.existsSync(directories[0]), false)
    })
  }

  for (const [name, screenshot] of [
    ['rejection', () => Promise.reject(new Error('session closed'))],
    ['synchronous throw', () => { throw new Error('session closed') }],
    ['missing screenshot', () => Promise.resolve(undefined)],
    ['invalid PNG', () => Promise.resolve(Buffer.from('not PNG').toString('base64'))],
    ['empty multiremote result', () => Promise.resolve([])],
  ]) {
    it(`handles capture ${name} without leaking files or rejecting a test`, async () => {
      browser.takeScreenshot.callsFake(screenshot)
      const recorder = start()
      const complete = sinon.spy()
      recorder.finish(true, () => assert.fail('unexpected upload'), complete)
      await clock.tickAsync(0)
      sinon.assert.calledOnceWithExactly(complete, 'error')
      sinon.assert.notCalled(encode)
      assert.strictEqual(fs.existsSync(directories[0]), false)
    })
  }

  it('bounds hung captures and ignores a late screenshot after cleanup', async () => {
    /** @type {((value: string) => void)|undefined} */
    let resolveCapture
    browser.takeScreenshot.callsFake(() => new Promise(resolve => { resolveCapture = resolve }))
    const recorder = start()
    const complete = sinon.spy()
    recorder.finish(true, () => assert.fail('unexpected upload'), complete)
    await clock.tickAsync(4999)
    sinon.assert.notCalled(complete)
    await clock.tickAsync(1)
    sinon.assert.calledOnceWithExactly(complete, 'error')
    assert.ok(resolveCapture)
    resolveCapture(PNG)
    await clock.tickAsync(0)
    sinon.assert.calledOnce(complete)
    assert.strictEqual(fs.existsSync(directories[0]), false)
  })

  for (const failure of ['encoding error', 'encoding throw', 'upload throw']) {
    it(`cleans up after ${failure}`, async () => {
      const error = new Error(failure)
      if (failure === 'encoding error') encode.callsFake((command, args, options, callback) => callback(error))
      if (failure === 'encoding throw') encode.throws(error)
      const recorder = start()
      const complete = sinon.spy()
      recorder.finish(true, () => { throw error }, complete)
      await clock.tickAsync(0)
      sinon.assert.calledOnceWithExactly(complete, 'error')
      assert.strictEqual(fs.existsSync(directories[0]), false)
    })
  }

  it('warns once and creates no files when FFmpeg is unavailable', () => {
    probe.returns({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }), status: null })
    assert.strictEqual(start(), undefined)
    assert.strictEqual(start(), undefined)
    sinon.assert.calledOnce(probe)
    sinon.assert.calledOnce(log.warn)
    sinon.assert.notCalled(browser.takeScreenshot)
    assert.deepStrictEqual(directories, [])
  })

  it('does no work before the browser exists', () => {
    assert.strictEqual(createVideo(undefined), undefined)
    sinon.assert.notCalled(probe)
    assert.deepStrictEqual(directories, [])
  })
})
