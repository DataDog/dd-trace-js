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
  let log
  let directories
  let recorders

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    directories = []
    recorders = []
    browser = Object.assign(new EventEmitter(), { takeScreenshot: sinon.stub().resolves(PNG) })
    encode = sinon.stub().callsFake(() => {
      const worker = new EventEmitter()
      queueMicrotask(() => worker.emit('exit', 0))
      return worker
    })
    log = { error: sinon.spy(), warn: sinon.spy() }
    createVideo = proxyquire('../../../datadog-plugin-mocha/src/webdriverio-video', {
      'node:worker_threads': { Worker: encode },
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
    assert.match(encode.firstCall.args[0], /webdriverio-video-worker\.js$/)
    assert.deepStrictEqual(encode.firstCall.args[1].execArgv, [])
    assert.strictEqual(encode.firstCall.args[1].env.NODE_OPTIONS, '')
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
      assert.deepStrictEqual(encode.args.map(([, { workerData }]) => workerData.frames), [1, 2])
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
    assert.deepStrictEqual(encode.args.map(([, { workerData }]) => workerData.frames), [1, 1])
  })

  it('keeps capture, encoding deadlines and queue progress independent of replaced global clocks', async () => {
    const workers = []
    encode.callsFake(() => {
      const worker = Object.assign(new EventEmitter(), { terminate: sinon.stub().resolves() })
      workers.push(worker)
      return worker
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
      sinon.assert.calledOnce(workers[0].terminate)
      workers[0].emit('exit', 1)
      await clock.tickAsync(0)
      sinon.assert.calledTwice(encode)
      workers[1].emit('exit', 0)
      sinon.assert.calledOnce(upload)
      assert.deepStrictEqual(complete.args, [['error'], ['uploaded']])
      for (const replacement of replacements) sinon.assert.notCalled(replacement)
    } finally {
      for (const replacement of replacements) replacement.restore()
    }
  })

  for (const outcome of ['resolve', 'reject', 'timeout', 'cancel']) {
    it(`releases a retry after capture ${outcome} without waiting for encoding or upload`, async () => {
      const worker = new EventEmitter()
      encode.callsFake(() => worker)
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
        worker.emit('exit', 0)
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
    const workers = []
    encode.callsFake(() => {
      const worker = new EventEmitter()
      workers.push(worker)
      return worker
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
      assert.strictEqual(encode.lastCall.args[1].workerData.directory, directories[attempt])
      workers[attempt].emit('exit', 0)
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

  for (const failure of ['worker error', 'nonzero exit', 'startup throw', 'timeout', 'termination rejection']) {
    it(`releases the encoder queue after ${failure}`, async () => {
      const workers = []
      encode.callsFake(() => {
        const worker = Object.assign(new EventEmitter(), { terminate: sinon.stub().resolves() })
        workers.push(worker)
        return worker
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
        if (failure === 'worker error') workers[0].emit('error', new Error(failure))
        if (failure === 'termination rejection') workers[0].terminate.rejects(new Error('termination failed'))
        if (failure === 'timeout' || failure === 'termination rejection') {
          await clock.tickAsync(30_000)
          sinon.assert.calledOnce(workers[0].terminate)
        }
        // Errors and termination requests do not release memory until the worker exits.
        sinon.assert.calledOnce(encode)
        sinon.assert.notCalled(complete)
        assert.ok(directories.every(directory => fs.existsSync(directory)))
        workers[0].emit('exit', 1)
        await clock.tickAsync(0)
      }
      sinon.assert.calledTwice(encode)
      sinon.assert.calledOnceWithExactly(complete, 'error')
      workers.at(-1).emit('exit', 0)
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
      const worker = Object.assign(new EventEmitter(), {
        terminate: sinon.stub().rejects(new Error('termination failed')),
        unref: sinon.spy(),
      })
      encode.callsFake(() => worker)
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
        worker.emit('exit', 0)
        await clock.tickAsync(0)
        sinon.assert.calledOnce(upload)
      }
      recorder.cancel()
      recorder.cancel()
      sinon.assert.calledOnceWithExactly(complete, 'error')
      assert.strictEqual(fs.existsSync(directories.at(-1)), false)
      if (stage === 'encoding') {
        sinon.assert.calledOnce(worker.terminate)
        sinon.assert.calledOnce(worker.unref)
      }
      if (stage === 'capture') {
        assert.ok(captured)
        captured(PNG)
      } else if (stage === 'upload') upload.firstCall.args[2]()
      else worker.emit('exit', 0)
      await clock.tickAsync(0)
      sinon.assert.calledOnce(complete)
      assert.strictEqual(encode.callCount, stage === 'capture' ? 0 : 1)
      assert.strictEqual(upload.callCount, stage === 'upload' ? 1 : 0)
      assert.strictEqual(fs.existsSync(directories.at(-1)), false)
    })
  }

  it('does not start a cancelled encoder whose queue microtask is already scheduled', async () => {
    const workers = []
    encode.callsFake(() => {
      const worker = new EventEmitter()
      workers.push(worker)
      return worker
    })
    const upload = sinon.spy((filePath, index, uploaded) => uploaded())
    const complete = sinon.spy()
    for (let index = 0; index < 3; index++) {
      start().finish(true, upload, complete)
      await clock.tickAsync(0)
    }
    await clock.tickAsync(0)
    workers[0].emit('exit', 0)
    recorders[1].cancel()
    await clock.tickAsync(0)
    sinon.assert.calledTwice(encode)
    assert.strictEqual(encode.lastCall.args[1].workerData.directory, directories[2])
    workers[1].emit('exit', 0)
    await clock.tickAsync(0)
    sinon.assert.calledTwice(upload)
    sinon.assert.calledThrice(complete)
    assert.ok(directories.every(directory => !fs.existsSync(directory)))
  })

  it('cancels a failed worker startup without removing the next queued attempt', async () => {
    encode.onFirstCall().throws(new Error('worker startup failed'))
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
        assert.strictEqual(encode.firstCall.args[1].workerData.frames, finalCapture ? 1 : 2)
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
    const frames = encode.args.map(([, { workerData }]) => [workerData.index, workerData.frames])
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
          const worker = new EventEmitter()
          queueMicrotask(() => {
            worker.emit('error', error)
            worker.emit('exit', 1)
          })
          return worker
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
    const worker = Object.assign(new EventEmitter(), { terminate: sinon.stub().resolves() })
    encode.returns(worker)
    const recorder = start()
    const complete = sinon.spy()
    recorder.finish(true, () => assert.fail('unexpected upload'), complete)
    await clock.tickAsync(29_999)
    sinon.assert.notCalled(worker.terminate)
    await clock.tickAsync(1)
    sinon.assert.calledOnce(worker.terminate)
    sinon.assert.notCalled(complete)
    assert.strictEqual(fs.existsSync(directories[0]), true)
    worker.emit('exit', 1)
    sinon.assert.calledOnceWithExactly(complete, 'error')
    assert.strictEqual(fs.existsSync(directories[0]), false)
  })

  it('does no work before the browser exists', () => {
    assert.strictEqual(createVideo(undefined), undefined)
    sinon.assert.notCalled(encode)
    assert.deepStrictEqual(directories, [])
  })
})
