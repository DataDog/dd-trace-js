'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const { dirname, join } = require('node:path')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII='

describe('WebdriverIO video recording', () => {
  let clock
  let createVideo
  let browser
  let encode
  let checkFfmpeg
  let log
  let directories
  let recorders

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    directories = []
    recorders = []
    browser = Object.assign(new EventEmitter(), { takeScreenshot: sinon.stub().resolves(PNG) })
    encode = sinon.stub().callsFake(() => {
      const encoder = new EventEmitter()
      queueMicrotask(() => encoder.emit('close', 0))
      return encoder
    })
    checkFfmpeg = sinon.stub().returns({ status: 0 })
    log = { error: sinon.spy(), warn: sinon.spy() }
    createVideo = proxyquire('../../../datadog-plugin-mocha/src/webdriverio-video', {
      'node:child_process': { spawn: encode, spawnSync: checkFfmpeg },
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
    browser.emit('result', { command: 'getWindowHandle' })
    browser.emit('result', { command: 'getWindowHandles' })
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
    assert.deepStrictEqual(encode.firstCall.args[2], { windowsHide: true, stdio: 'ignore' })
    const args = encode.firstCall.args[1]
    assert.strictEqual(args[args.indexOf('-i') + 1], join(directories[0], '0-%d.png'))
    assert.strictEqual(args[args.indexOf('-c:v') + 1], 'libvpx')
    assert.strictEqual(args[args.indexOf('-framerate') + 1], '2')
    assert.strictEqual(args[args.indexOf('-vf') + 1], 'scale=2:2,setsar=1')
    assert.strictEqual(args.at(-1), filePath)
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

  for (const outcome of ['resolve', 'reject', 'timeout']) {
    it(`serializes pending screenshots across attempts after ${outcome}`, async () => {
      const first = start()
      await clock.tickAsync(0)
      /** @type {(() => void)|undefined} */
      let settle
      browser.takeScreenshot.onSecondCall().callsFake(() => new Promise((resolve, reject) => {
        settle = () => outcome === 'reject' ? reject(new Error('navigation interrupted')) : resolve(PNG)
      }))
      const upload = sinon.spy((filePath, index, uploaded) => uploaded())
      const complete = sinon.spy()
      first.finish(true, upload, complete)
      const second = start()
      await clock.tickAsync(outcome === 'timeout' ? 5000 : 500)
      sinon.assert.calledTwice(browser.takeScreenshot)
      assert.ok(settle)
      settle()
      await clock.tickAsync(500)
      sinon.assert.calledThrice(browser.takeScreenshot)
      second.finish(true, upload, complete)
      await clock.tickAsync(0)
      assert.deepStrictEqual(encode.args.map(([, args]) => Number(args[args.indexOf('-frames:v') + 1])), [1, 2])
      sinon.assert.calledTwice(upload)
      assert.deepStrictEqual(complete.args, [['uploaded'], ['uploaded']])
    })
  }

  it('keeps a multiremote capture locked until every session settles after a rejection', async () => {
    const first = { takeScreenshot: sinon.stub().resolves(PNG) }
    const second = { takeScreenshot: sinon.stub().resolves(PNG) }
    /** @type {((value: string) => void)|undefined} */
    let resolveCapture
    first.takeScreenshot.onSecondCall().rejects(new Error('navigation interrupted'))
    second.takeScreenshot.onSecondCall().callsFake(() => new Promise(resolve => { resolveCapture = resolve }))
    Object.assign(browser, {
      isMultiremote: true,
      instances: ['first', 'second'],
      getInstance: name => name === 'first' ? first : second,
    })
    const previous = start()
    await clock.tickAsync(0)
    const upload = sinon.spy((filePath, index, uploaded) => uploaded())
    previous.finish(true, upload, () => {})
    start()
    await clock.tickAsync(5000)
    sinon.assert.calledTwice(first.takeScreenshot)
    sinon.assert.calledTwice(second.takeScreenshot)
    assert.ok(resolveCapture)
    resolveCapture(PNG)
    await clock.tickAsync(500)
    sinon.assert.calledThrice(first.takeScreenshot)
    sinon.assert.calledThrice(second.takeScreenshot)
    assert.deepStrictEqual(encode.args.map(([, args]) => Number(args[args.indexOf('-frames:v') + 1])), [1, 1])
  })

  it('keeps capture, encoding deadlines and queue progress independent of replaced global clocks', async () => {
    const encoders = []
    encode.callsFake(() => {
      const encoder = Object.assign(new EventEmitter(), { kill: sinon.stub().returns(true) })
      encoders.push(encoder)
      return encoder
    })
    const timerNames = /** @type {const} */ ([
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
    ])
    const replacements = timerNames.map(name => {
      return sinon.stub(globalThis, name).throws(new Error('test replaced the global clock'))
    })
    try {
      const first = start()
      await clock.tickAsync(500)
      sinon.assert.calledTwice(browser.takeScreenshot)
      const upload = sinon.spy((filePath, index, uploaded) => uploaded())
      const complete = sinon.spy()
      first.finish(true, upload, complete)
      await clock.tickAsync(0)
      const second = start()
      second.finish(true, upload, complete)
      await clock.tickAsync(30_000)
      sinon.assert.calledOnceWithExactly(encoders[0].kill, 'SIGKILL')
      encoders[0].emit('close', 1)
      await clock.tickAsync(0)
      sinon.assert.calledTwice(encode)
      encoders[1].emit('close', 0)
      sinon.assert.calledOnce(upload)
      assert.deepStrictEqual(complete.args, [['error'], ['uploaded']])
      for (const replacement of replacements) sinon.assert.notCalled(replacement)
    } finally {
      for (const replacement of replacements) replacement.restore()
    }
  })

  for (const outcome of ['resolve', 'reject', 'timeout', 'cancel']) {
    it(`releases a retry after capture ${outcome} without waiting for encoding or upload`, async () => {
      const encoder = new EventEmitter()
      encode.callsFake(() => encoder)
      const recorder = start()
      await clock.tickAsync(0)
      /** @type {(() => void)|undefined} */
      let settle
      browser.takeScreenshot.callsFake(() => new Promise((resolve, reject) => {
        settle = () => outcome === 'reject' ? reject(new Error('capture failed')) : resolve(PNG)
      }))
      const uploaded = sinon.spy()
      const upload = sinon.spy()
      const captured = sinon.spy()
      recorder.finish(true, upload, uploaded)
      recorder.waitForCapture(captured)
      sinon.assert.notCalled(captured)
      assert.ok(settle)
      if (outcome === 'cancel') recorder.cancel()
      else if (outcome === 'timeout') await clock.tickAsync(5000)
      else settle()
      await clock.tickAsync(0)
      sinon.assert.calledOnce(captured)
      if (outcome === 'cancel') {
        sinon.assert.notCalled(encode)
        sinon.assert.calledOnceWithExactly(uploaded, 'error')
      } else {
        sinon.assert.calledOnce(encode)
        sinon.assert.notCalled(uploaded)
        encoder.emit('close', 0)
        sinon.assert.calledOnce(upload)
        sinon.assert.notCalled(uploaded)
        upload.firstCall.args[2]()
        sinon.assert.calledOnceWithExactly(uploaded, 'uploaded')
      }
      settle()
      await clock.tickAsync(0)
      sinon.assert.calledOnce(captured)
      recorder.waitForCapture(captured)
      sinon.assert.calledTwice(captured)
    })
  }

  it('serializes encoders across failed attempts without waiting for uploads', async () => {
    const encoders = []
    encode.callsFake(() => {
      const encoder = new EventEmitter()
      encoders.push(encoder)
      return encoder
    })
    const upload = sinon.spy()
    const complete = sinon.spy()
    for (let attempt = 0; attempt < 3; attempt++) {
      start().finish(true, upload, complete)
      await clock.tickAsync(0)
    }
    await clock.tickAsync(0)
    sinon.assert.calledOnce(encode)

    for (let attempt = 0; attempt < 3; attempt++) {
      assert.strictEqual(encode.callCount, attempt + 1)
      assert.strictEqual(dirname(encode.lastCall.args[1].at(-1)), directories[attempt])
      encoders[attempt].emit('close', 0)
      await clock.tickAsync(0)
    }
    sinon.assert.calledThrice(upload)
    sinon.assert.notCalled(complete)
    for (const [filePath, , uploaded] of upload.args) {
      assert.strictEqual(fs.existsSync(dirname(filePath)), true)
      uploaded()
      assert.strictEqual(fs.existsSync(dirname(filePath)), false)
    }
    sinon.assert.calledThrice(complete)
  })

  for (const failure of ['encoder error', 'nonzero exit', 'startup throw', 'timeout', 'failed kill']) {
    it(`releases the encoder queue after ${failure}`, async () => {
      const encoders = []
      encode.callsFake(() => {
        const encoder = Object.assign(new EventEmitter(), { kill: sinon.stub().returns(true) })
        encoders.push(encoder)
        return encoder
      })
      if (failure === 'startup throw') encode.onFirstCall().throws(new Error(failure))
      const complete = sinon.spy()
      const upload = sinon.spy((filePath, index, uploaded) => uploaded())
      start().finish(true, upload, complete)
      await clock.tickAsync(0)
      start().finish(true, upload, complete)
      await clock.tickAsync(0)

      if (failure !== 'startup throw') {
        sinon.assert.calledOnce(encode)
        if (failure === 'encoder error') encoders[0].emit('error', new Error(failure))
        if (failure === 'failed kill') encoders[0].kill.returns(false)
        if (failure === 'timeout' || failure === 'failed kill') {
          await clock.tickAsync(30_000)
          sinon.assert.calledOnceWithExactly(encoders[0].kill, 'SIGKILL')
        }
        // Errors and kill requests do not release the slot until the encoder closes.
        sinon.assert.calledOnce(encode)
        sinon.assert.notCalled(complete)
        assert.ok(directories.every(directory => fs.existsSync(directory)))
        encoders[0].emit('close', 1)
        await clock.tickAsync(0)
      }
      sinon.assert.calledTwice(encode)
      sinon.assert.calledOnceWithExactly(complete, 'error')
      encoders.at(-1).emit('close', 0)
      await clock.tickAsync(0)
      sinon.assert.calledOnce(upload)
      assert.deepStrictEqual(complete.args, [['error'], ['uploaded']])
      assert.ok(directories.every(directory => !fs.existsSync(directory)))
    })
  }

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

  for (const stage of ['capture', 'queue', 'encoding', 'upload']) {
    it(`cancels during ${stage} without uploading or completing again`, async () => {
      const encoder = Object.assign(new EventEmitter(), {
        kill: sinon.stub().returns(false),
        unref: sinon.spy(),
      })
      encode.callsFake(() => encoder)
      browser.takeScreenshot.resolves([PNG, PNG])
      /** @type {((value: string) => void)|undefined} */
      let captured
      if (stage === 'capture') browser.takeScreenshot.callsFake(() => new Promise(resolve => { captured = resolve }))
      if (stage === 'queue') {
        start().finish(true, () => {}, () => {})
        await clock.tickAsync(0)
      }
      const recorder = start()
      const upload = sinon.spy()
      const complete = sinon.spy()
      recorder.finish(true, upload, complete)
      await clock.tickAsync(0)
      if (stage === 'upload') {
        encoder.emit('close', 0)
        await clock.tickAsync(0)
        sinon.assert.calledOnce(upload)
      }
      recorder.cancel()
      recorder.cancel()
      sinon.assert.calledOnceWithExactly(complete, 'error')
      assert.strictEqual(fs.existsSync(directories.at(-1)), false)
      if (stage === 'encoding') {
        sinon.assert.calledOnceWithExactly(encoder.kill, 'SIGKILL')
        sinon.assert.calledOnce(encoder.unref)
      }
      if (stage === 'capture') {
        assert.ok(captured)
        captured(PNG)
      } else if (stage === 'upload') upload.firstCall.args[2]()
      else encoder.emit('close', 0)
      await clock.tickAsync(0)
      sinon.assert.calledOnce(complete)
      assert.strictEqual(encode.callCount, stage === 'capture' ? 0 : 1)
      assert.strictEqual(upload.callCount, stage === 'upload' ? 1 : 0)
      assert.strictEqual(fs.existsSync(directories.at(-1)), false)
    })
  }

  it('does not start a cancelled encoder whose queue microtask is already scheduled', async () => {
    const encoders = []
    encode.callsFake(() => {
      const encoder = new EventEmitter()
      encoders.push(encoder)
      return encoder
    })
    const upload = sinon.spy((filePath, index, uploaded) => uploaded())
    const complete = sinon.spy()
    for (let index = 0; index < 3; index++) {
      start().finish(true, upload, complete)
      await clock.tickAsync(0)
    }
    await clock.tickAsync(0)
    encoders[0].emit('close', 0)
    recorders[1].cancel()
    await clock.tickAsync(0)
    sinon.assert.calledTwice(encode)
    assert.strictEqual(dirname(encode.lastCall.args[1].at(-1)), directories[2])
    encoders[1].emit('close', 0)
    await clock.tickAsync(0)
    sinon.assert.calledTwice(upload)
    sinon.assert.calledThrice(complete)
    assert.ok(directories.every(directory => !fs.existsSync(directory)))
  })

  it('cancels a failed encoder startup without removing the next queued attempt', async () => {
    encode.onFirstCall().throws(new Error('encoder startup failed'))
    const upload = sinon.spy((filePath, index, uploaded) => uploaded())
    const complete = sinon.spy()
    const first = start()
    await clock.tickAsync(0)
    browser.takeScreenshot.returns({ then: callback => callback(PNG) })
    first.finish(true, upload, complete)
    const second = start()
    second.finish(true, upload, complete)
    first.cancel()
    await clock.tickAsync(0)
    sinon.assert.calledTwice(encode)
    sinon.assert.calledOnce(upload)
    assert.deepStrictEqual(complete.args, [['error'], ['uploaded']])
    assert.ok(directories.every(directory => !fs.existsSync(directory)))
  })

  it('uses the standard screenshot command for mixed Classic and BiDi multiremote sessions', async () => {
    const classic = { takeScreenshot: sinon.stub().resolves(PNG) }
    const bidi = {
      isBidi: true,
      browsingContextCaptureScreenshot: sinon.stub().throws(new Error('capture lost its context during navigation')),
      takeScreenshot: sinon.stub().resolves(PNG),
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
    sinon.assert.calledOnce(bidi.takeScreenshot)
    sinon.assert.notCalled(browser.takeScreenshot)
    sinon.assert.notCalled(bidi.browsingContextCaptureScreenshot)
    sinon.assert.calledTwice(upload)
    sinon.assert.calledOnceWithExactly(complete, 'uploaded')
  })

  for (const capture of ['single', 'consecutive', 'multiremote']) {
    for (const bytes of [200 * 1024 * 1024, 200 * 1024 * 1024 + 1]) {
      it(`enforces the raw recording limit before decoding ${bytes} bytes across ${capture} captures`, async () => {
        const firstFrame = Buffer.from(PNG, 'base64')
        const frame = Buffer.alloc(bytes - (capture === 'single' ? 0 : firstFrame.length))
        firstFrame.copy(frame)
        const screenshot = frame.toString('base64')
        browser.takeScreenshot.resolves(screenshot)
        if (capture === 'consecutive') browser.takeScreenshot.onFirstCall().resolves(PNG)
        if (capture === 'multiremote') {
          const first = { takeScreenshot: sinon.stub().resolves(PNG) }
          const second = { takeScreenshot: sinon.stub().resolves(screenshot) }
          Object.assign(browser, {
            isMultiremote: true,
            instances: ['first', 'second'],
            getInstance: name => name === 'first' ? first : second,
          })
        }
        const decode = sinon.spy(Buffer, 'from')
        try {
          const recorder = start()
          if (capture === 'consecutive') await clock.tickAsync(0)
          const complete = sinon.spy()
          const upload = sinon.spy((filePath, index, callback) => callback())
          recorder.finish(true, upload, complete)
          await clock.tickAsync(0)
          const accepted = bytes === 200 * 1024 * 1024
          sinon.assert.calledOnceWithExactly(complete, accepted ? 'uploaded' : 'error')
          const decodedFrames = decode.args.filter(([value, encoding]) => value === screenshot && encoding === 'base64')
          assert.strictEqual(decodedFrames.length, accepted ? 1 : 0, 'oversized frames must not be decoded')
          assert.strictEqual(upload.callCount, accepted ? (capture === 'multiremote' ? 2 : 1) : 0)
          assert.strictEqual(encode.callCount, upload.callCount)
          assert.strictEqual(fs.existsSync(directories[0]), false)
        } finally {
          decode.restore()
        }
      })
    }
  }

  for (const [name, screenshot] of [
    ['rejection', () => Promise.reject(new Error('session closed'))],
    ['synchronous throw', () => { throw new Error('session closed') }],
    ['missing screenshot', () => Promise.resolve(undefined)],
    ['truncated PNG', () => Promise.resolve(Buffer.from(PNG, 'base64').subarray(0, 8).toString('base64'))],
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

  for (const failure of ['rejection', 'synchronous throw', 'timeout']) {
    for (const finalCapture of [false, true]) {
      it(`${finalCapture ? 'preserves recorded frames' : 'resumes capture'} after ${failure}`, async () => {
        /** @type {((value: string) => void)|undefined} */
        let resolveCapture
        const failingCapture = browser.takeScreenshot.onCall(finalCapture ? 1 : 0)
        if (failure === 'rejection') failingCapture.rejects(new Error('navigation interrupted capture'))
        if (failure === 'synchronous throw') failingCapture.throws(new Error('navigation interrupted capture'))
        if (failure === 'timeout') {
          failingCapture.callsFake(() => new Promise(resolve => { resolveCapture = resolve }))
        }

        const recorder = start()
        const complete = sinon.spy()
        const upload = sinon.spy((filePath, index, uploaded) => uploaded())
        if (finalCapture) {
          await clock.tickAsync(0)
          recorder.finish(true, upload, complete)
          await clock.tickAsync(failure === 'timeout' ? 5000 : 0)
        } else {
          await clock.tickAsync(failure === 'timeout' ? 5000 : 500)
          if (failure === 'timeout') {
            sinon.assert.calledOnce(browser.takeScreenshot)
            resolveCapture?.(PNG)
            await clock.tickAsync(500)
          }
          recorder.finish(true, upload, complete)
          await clock.tickAsync(0)
        }

        sinon.assert.calledOnce(encode)
        const args = encode.firstCall.args[1]
        assert.strictEqual(Number(args[args.indexOf('-frames:v') + 1]), finalCapture ? 1 : 2)
        sinon.assert.calledOnceWithExactly(complete, 'uploaded')
        sinon.assert.calledOnce(log.error)
        resolveCapture?.(PNG)
        await clock.tickAsync(0)
        sinon.assert.calledOnce(upload)
        assert.strictEqual(fs.existsSync(directories[0]), false)
      })
    }
  }

  it('preserves every multiremote recording when one session rejects its final capture', async () => {
    const first = { takeScreenshot: sinon.stub().resolves(PNG) }
    const second = { takeScreenshot: sinon.stub().resolves(PNG) }
    first.takeScreenshot.onSecondCall().rejects(new Error('session closed'))
    Object.assign(browser, {
      isMultiremote: true,
      instances: ['first', 'second'],
      getInstance: name => name === 'first' ? first : second,
    })
    const recorder = start()
    await clock.tickAsync(0)
    const upload = sinon.spy((filePath, index, uploaded) => uploaded())
    const complete = sinon.spy()
    recorder.finish(true, upload, complete)
    await clock.tickAsync(0)
    const frames = encode.args.map(([, args], index) => [index, Number(args[args.indexOf('-frames:v') + 1])])
    assert.deepStrictEqual(frames, [[0, 1], [1, 1]])
    sinon.assert.calledTwice(upload)
    sinon.assert.calledOnceWithExactly(complete, 'uploaded')
    assert.strictEqual(fs.existsSync(directories[0]), false)
  })

  for (const failure of ['encoding error', 'encoding throw', 'upload throw']) {
    it(`cleans up after ${failure}`, async () => {
      const error = new Error(failure)
      if (failure === 'encoding error') {
        encode.callsFake(() => {
          const encoder = new EventEmitter()
          queueMicrotask(() => {
            encoder.emit('error', error)
            encoder.emit('close', 1)
          })
          return encoder
        })
      }
      if (failure === 'encoding throw') encode.throws(error)
      const recorder = start()
      const complete = sinon.spy()
      recorder.finish(true, () => { throw error }, complete)
      await clock.tickAsync(0)
      sinon.assert.calledOnceWithExactly(complete, 'error')
      assert.strictEqual(fs.existsSync(directories[0]), false)
    })
  }

  it('terminates a hung encoder before removing its files', async () => {
    const encoder = Object.assign(new EventEmitter(), { kill: sinon.stub().returns(true) })
    encode.returns(encoder)
    const recorder = start()
    const complete = sinon.spy()
    recorder.finish(true, () => assert.fail('unexpected upload'), complete)
    await clock.tickAsync(29_999)
    sinon.assert.notCalled(encoder.kill)
    await clock.tickAsync(1)
    sinon.assert.calledOnceWithExactly(encoder.kill, 'SIGKILL')
    sinon.assert.notCalled(complete)
    assert.strictEqual(fs.existsSync(directories[0]), true)
    encoder.emit('close', 1)
    sinon.assert.calledOnceWithExactly(complete, 'error')
    assert.strictEqual(fs.existsSync(directories[0]), false)
  })

  for (const failure of ['missing executable', 'nonzero status', 'startup throw']) {
    it(`disables recording safely after FFmpeg preflight ${failure}`, () => {
      if (failure === 'missing executable') checkFfmpeg.returns({ error: new Error('ENOENT'), status: null })
      if (failure === 'nonzero status') checkFfmpeg.returns({ status: 1 })
      if (failure === 'startup throw') checkFfmpeg.throws(new Error('startup failed'))
      assert.strictEqual(start(), undefined)
      sinon.assert.notCalled(browser.takeScreenshot)
      sinon.assert.notCalled(encode)
      assert.deepStrictEqual(directories, [])
      sinon.assert.calledOnce(failure === 'startup throw' ? log.error : log.warn)
      if (failure !== 'startup throw') {
        assert.strictEqual(start(), undefined)
        sinon.assert.calledOnce(checkFfmpeg)
        sinon.assert.calledOnce(log.warn)
      }
    })
  }

  it('checks FFmpeg only once per WDIO process with a bounded preflight', () => {
    start()
    start()
    sinon.assert.calledOnceWithExactly(checkFfmpeg, 'ffmpeg', ['-version'], {
      timeout: 5000, killSignal: 'SIGKILL', windowsHide: true, stdio: 'ignore',
    })
  })

  for (const [width, height, accepted] of /** @type {const} */ ([
    [4096, 4096, true], [16 * 1024 * 1024 + 1, 1, false], [0, 1, false], [1, 0, false],
  ])) {
    it(`validates ${width}x${height} PNG dimensions before encoding`, async () => {
      const frame = Buffer.from(PNG, 'base64')
      frame.writeUInt32BE(width, 16)
      frame.writeUInt32BE(height, 20)
      browser.takeScreenshot.resolves(frame.toString('base64'))
      const complete = sinon.spy()
      start().finish(true, (filePath, index, uploaded) => uploaded(), complete)
      await clock.tickAsync(0)
      sinon.assert.calledOnceWithExactly(complete, accepted ? 'uploaded' : 'error')
      assert.strictEqual(encode.callCount, accepted ? 1 : 0)
      if (accepted) {
        const args = encode.firstCall.args[1]
        assert.strictEqual(args[args.indexOf('-vf') + 1], 'scale=720:720,setsar=1')
      }
    })
  }

  it('preserves the first frame size across odd dimensions and viewport changes', async () => {
    const frame = Buffer.from(PNG, 'base64')
    frame.writeUInt32BE(3, 16)
    frame.writeUInt32BE(5, 20)
    browser.takeScreenshot.onFirstCall().resolves(frame.toString('base64'))
    const recorder = start()
    await clock.tickAsync(0)
    recorder.finish(true, (filePath, index, uploaded) => uploaded(), () => {})
    await clock.tickAsync(0)
    const args = encode.firstCall.args[1]
    assert.strictEqual(args[args.indexOf('-vf') + 1], 'scale=2:4,setsar=1')
    assert.strictEqual(args[args.indexOf('-frames:v') + 1], '2')
  })

  it('does no work before the browser exists', () => {
    assert.strictEqual(createVideo(undefined), undefined)
    sinon.assert.notCalled(encode)
    sinon.assert.notCalled(checkFfmpeg)
    assert.deepStrictEqual(directories, [])
  })
})
