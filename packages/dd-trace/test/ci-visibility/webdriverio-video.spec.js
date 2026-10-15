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
  let removeFrames
  let writeFrame
  let log
  let directories
  let recorders

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    directories = []
    recorders = []
    browser = Object.assign(new EventEmitter(), {
      capabilities: { unhandledPromptBehavior: 'ignore' },
      takeScreenshot: sinon.stub().resolves(PNG),
    })
    encode = sinon.stub().callsFake(() => {
      const encoder = new EventEmitter()
      queueMicrotask(() => encoder.emit('close', 0))
      return encoder
    })
    checkFfmpeg = sinon.stub().returns({ status: 0, stdout: ' V....D libvpx               libvpx VP8 (codec vp8)\n' })
    removeFrames = sinon.stub().callsFake(fs.rmSync)
    writeFrame = sinon.stub().callsFake(fs.writeFileSync)
    log = { error: sinon.spy(), warn: sinon.spy() }
    createVideo = proxyquire('../../../datadog-plugin-mocha/src/webdriverio-video', {
      'node:child_process': { spawn: encode, spawnSync: checkFfmpeg },
      'node:perf_hooks': { performance: { now: () => clock.performance.now() } },
      'node:fs': {
        rmSync: removeFrames,
        writeFileSync: writeFrame,
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
    browser.takeScreenshot.reset()
    writeFrame.reset()
  })

  function start () {
    const recorder = createVideo(browser)
    if (recorder) recorders.push(recorder)
    return recorder
  }

  for (const multiremote of [false, true]) {
    it(`preserves command, idle and retry timing (multiremote=${multiremote})`, async () => {
      if (multiremote) {
        Object.assign(browser, {
          isMultiremote: true,
          instances: ['first', 'second'],
          getInstance: () => ({ capabilities: browser.capabilities, takeScreenshot: browser.takeScreenshot }),
        })
      }
      for (const elapsed of [1000, 2000]) {
        const recorder = start()
        await clock.tickAsync(0)
        for (let command = 0; command < 3; command++) {
          await clock.tickAsync(100)
          browser.emit('result', { command: 'getElementText' })
          await clock.tickAsync(0)
        }
        // Changes to the customer's wall clock must not change playback timing.
        clock.setSystemTime(-86_400_000)
        await clock.tickAsync(elapsed - 300)
        const upload = sinon.spy()
        recorder.finish(true, upload, () => {})
        await clock.tickAsync(0)
        for (let index = 0; index < (multiremote ? 2 : 1); index++) {
          const [filePath, , uploaded] = upload.args[index]
          const manifest = fs.readFileSync(join(dirname(filePath), `${index}.ffconcat`), 'utf8')
          const durations = [...manifest.matchAll(/^duration (.+)$/gm)].map(match => Number(match[1]))
          assert.deepStrictEqual(durations.slice(0, 4), [0.1, 0.1, 0.1, 0.2])
          assert.strictEqual(durations.reduce((sum, duration) => sum + duration, 0), elapsed / 1000 + 0.04)
          assert.match(manifest, new RegExp(`duration 0.040000\\nfile ${index}-\\d+\\.png\\n$`))
          uploaded()
          await clock.tickAsync(0)
        }
      }
    })
  }

  it('preserves gaps while screenshots are pending', async () => {
    const recorder = start()
    await clock.tickAsync(0)
    let resolveCapture
    browser.takeScreenshot.onSecondCall().callsFake(() => new Promise(resolve => { resolveCapture = resolve }))
    await clock.tickAsync(100)
    browser.emit('result', { command: 'getElementText' })
    await clock.tickAsync(1200)
    resolveCapture(PNG)
    await clock.tickAsync(0)
    const upload = sinon.spy()
    recorder.finish(true, upload, () => {})
    await clock.tickAsync(0)
    const manifest = fs.readFileSync(join(directories[0], '0.ffconcat'), 'utf8')
    assert.match(manifest, /file 0-0\.png\nduration 1.300000\n/)
    upload.firstCall.args[2]()
  })

  for (const slowSession of [0, 1]) {
    for (const finishDuringCapture of [false, true]) {
      it(`timestamps each session independently (slow=${slowSession}, overlapping finish=${finishDuringCapture})`,
        async () => {
          const sessions = [0, 1].map(index => {
            const takeScreenshot = sinon.stub()
            // Reverse completion order in the final batch to check both ends of each interval.
            const delays = index === slowSession ? [3900, 50] : [100, 300]
            for (const [call, delay] of delays.entries()) {
              takeScreenshot.onCall(call).callsFake(() => new Promise(resolve => setTimeout(() => resolve(PNG), delay)))
            }
            return { capabilities: browser.capabilities, takeScreenshot }
          })
          Object.assign(browser, {
            isMultiremote: true,
            instances: ['first', 'second'],
            getInstance: name => sessions[name === 'first' ? 0 : 1],
          })
          const recorder = start()
          // Finish between periodic ticks when exercising the non-overlapping capture path.
          await clock.tickAsync(finishDuringCapture ? 100 : 3900)
          const durations = []
          const complete = sinon.spy()
          recorder.finish(true, (filePath, index, uploaded) => {
            const manifest = fs.readFileSync(join(dirname(filePath), `${index}.ffconcat`), 'utf8')
            durations[index] = [...manifest.matchAll(/^duration (.+)$/gm)].map(match => Number(match[1]))
            uploaded()
          }, complete)
          await clock.tickAsync(finishDuringCapture ? 4100 : 300)
          assert.deepStrictEqual(durations[1 - slowSession], [4.1, 0.04])
          assert.deepStrictEqual(durations[slowSession], [0.05, 0.04])
          for (const session of sessions) sinon.assert.calledTwice(session.takeScreenshot)
          sinon.assert.calledOnceWithExactly(complete, 'uploaded')
        })
    }
  }

  it('cleans up and releases the encoding queue when the timing manifest cannot be written', async () => {
    writeFrame.withArgs(sinon.match(/\.ffconcat$/)).throws(new Error('disk full'))
    const complete = sinon.spy()
    start().finish(true, () => assert.fail('unexpected upload'), complete)
    await clock.tickAsync(0)
    sinon.assert.calledOnceWithExactly(complete, 'error')
    sinon.assert.notCalled(encode)
    assert.strictEqual(fs.existsSync(directories[0]), false)
    writeFrame.resetBehavior()
    writeFrame.callsFake(fs.writeFileSync)
    start().finish(true, (filePath, index, uploaded) => uploaded(), complete)
    await clock.tickAsync(0)
    assert.deepStrictEqual(complete.args, [['error'], ['uploaded']])
    sinon.assert.calledOnce(encode)
  })

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
    assert.strictEqual(fs.readdirSync(dirname(filePath)).length, 5)
    assert.strictEqual(browser.listenerCount('result'), 0)
    assert.strictEqual(encode.firstCall.args[0], 'ffmpeg')
    assert.deepStrictEqual(encode.firstCall.args[2], { windowsHide: true, stdio: 'ignore' })
    const args = encode.firstCall.args[1]
    assert.strictEqual(args[args.indexOf('-i') + 1], join(directories[0], '0.ffconcat'))
    assert.strictEqual(args[args.indexOf('-c:v') + 1], 'libvpx')
    assert.strictEqual(args[args.indexOf('-f') + 1], 'concat')
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

  for (const policy of [undefined, 'dismiss', 'accept', 'dismiss and notify', 'accept and notify',
    { default: 'ignore', alert: 'dismiss' }]) {
    it(`disables video when screenshots could handle prompts: ${JSON.stringify(policy)}`, () => {
      browser.capabilities = { unhandledPromptBehavior: policy }
      assert.strictEqual(start(), undefined)
      assert.strictEqual(start(), undefined)
      sinon.assert.notCalled(browser.takeScreenshot)
      sinon.assert.notCalled(checkFfmpeg)
      sinon.assert.calledOnce(log.warn)
      assert.match(log.warn.firstCall.args.join(' '), /unhandledPromptBehavior/)
      assert.deepStrictEqual(directories, [])
    })
  }

  it('accepts a prompt-handler map that ignores every dialog type', async () => {
    browser.capabilities = { unhandledPromptBehavior: { default: 'ignore', alert: 'ignore' } }
    start()
    await clock.tickAsync(0)
    sinon.assert.calledOnce(browser.takeScreenshot)
    sinon.assert.notCalled(log.warn)
  })

  for (const unsafeSession of ['first', 'second']) {
    for (const flag of ['isMultiremote', 'isMultiRemote']) {
      it(`disables multiremote video when ${unsafeSession} could handle prompts (${flag})`, () => {
        const sessions = Object.fromEntries(['first', 'second'].map(name => [name, {
          capabilities: { unhandledPromptBehavior: name === unsafeSession ? 'dismiss and notify' : 'ignore' },
          takeScreenshot: sinon.stub().resolves(PNG),
        }]))
        Object.assign(browser, {
          [flag]: true,
          instances: ['first', 'second'],
          getInstance: name => sessions[name],
        })
        assert.strictEqual(start(), undefined)
        sinon.assert.notCalled(sessions.first.takeScreenshot)
        sinon.assert.notCalled(sessions.second.takeScreenshot)
        sinon.assert.calledOnce(log.warn)
      })
    }
  }

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

  for (const multiremote of [false, true]) {
    for (const trigger of ['command', 'interval', 'finish']) {
      it(`disables a reloaded unsafe session during ${trigger} capture (multiremote=${multiremote})`, async () => {
        const session = multiremote
          ? { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
          : browser
        if (multiremote) {
          Object.assign(browser, { isMultiremote: true, instances: ['reloaded'], getInstance: () => session })
        }
        const recorder = start()
        await clock.tickAsync(0)
        session.capabilities = { unhandledPromptBehavior: 'dismiss and notify' }
        if (trigger === 'command') browser.emit('result', { command: 'reloadSession' })
        if (trigger === 'interval') await clock.tickAsync(500)
        const complete = sinon.spy()
        recorder.finish(true, () => assert.fail('unsafe session must not upload'), complete)
        await clock.tickAsync(500)
        sinon.assert.calledOnce(session.takeScreenshot)
        sinon.assert.notCalled(encode)
        sinon.assert.calledOnceWithExactly(complete, undefined)
        sinon.assert.calledOnce(log.warn)
        assert.strictEqual(browser.listenerCount('result'), 0)
        assert.strictEqual(fs.existsSync(directories[0]), false)
      })
    }

    for (const outcome of ['resolve', 'reject', 'earlier rejection', 'timeout', 'cancel']) {
      it(`waits for a fresh final capture after overlap: ${outcome} (multiremote=${multiremote})`, async () => {
        const recorder = start()
        await clock.tickAsync(0)
        const pending = []
        browser.takeScreenshot.callsFake(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }) }))
        const other = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
        if (outcome === 'earlier rejection') {
          other.takeScreenshot.onFirstCall().rejects(new Error('earlier screenshot failed'))
        }
        if (multiremote) {
          Object.assign(browser, {
            isMultiremote: true,
            instances: ['first', 'second'],
            getInstance: name => name === 'first' ? other : browser,
          })
        }
        recorder.capture()
        await clock.tickAsync(100)
        const upload = sinon.spy()
        const complete = sinon.spy()
        const ready = sinon.spy()
        recorder.finish(true, upload, complete)
        recorder.waitForCapture(ready)
        await clock.tickAsync(100)
        sinon.assert.notCalled(ready)
        sinon.assert.notCalled(encode)
        if (outcome === 'earlier rejection' && !multiremote) {
          pending[0].reject(new Error('earlier screenshot failed'))
        } else {
          pending[0].resolve(PNG)
        }
        await clock.tickAsync(0)
        assert.strictEqual(pending.length, 2, 'a fresh screenshot must follow the outstanding request')
        sinon.assert.notCalled(ready)
        sinon.assert.notCalled(encode)
        if (outcome === 'cancel') recorder.cancel()
        else if (outcome === 'timeout') {
          await clock.tickAsync(4799)
          sinon.assert.notCalled(ready)
          await clock.tickAsync(1)
        } else if (outcome === 'reject') pending[1].reject(new Error('final screenshot failed'))
        else pending[1].resolve(PNG)
        await clock.tickAsync(0)
        sinon.assert.calledOnce(ready)
        if (outcome === 'cancel') {
          sinon.assert.notCalled(encode)
          sinon.assert.calledOnceWithExactly(complete, 'error')
        } else {
          sinon.assert.calledOnce(encode)
          const args = encode.firstCall.args[1]
          assert.strictEqual(Number(args[args.indexOf('-frames:v') + 1]), outcome === 'resolve' ? 4 : 3)
          sinon.assert.notCalled(complete)
          upload.firstCall.args[2]()
          await clock.tickAsync(0)
          if (multiremote) upload.secondCall.args[2]()
          sinon.assert.calledOnceWithExactly(complete, 'uploaded')
        }
        pending[1].resolve(PNG)
        await clock.tickAsync(0)
        sinon.assert.calledOnce(ready)
        assert.strictEqual(fs.existsSync(directories[0]), false)
      })
    }
  }

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
      assert.deepStrictEqual(encode.args.map(([, args]) => Number(args[args.indexOf('-frames:v') + 1])), [2, 3])
      sinon.assert.calledTwice(upload)
      assert.deepStrictEqual(complete.args, [['uploaded'], ['uploaded']])
    })
  }

  it('keeps a multiremote capture locked until every session settles after a rejection', async () => {
    const first = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
    const second = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
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
    assert.deepStrictEqual(encode.args.map(([, args]) => Number(args[args.indexOf('-frames:v') + 1])), [2, 2])
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

  for (const capture of ['single', 'multiremote']) {
    for (const release of ['completion', 'cancellation']) {
      it(`drops excess ${capture} recordings from a full encoder queue and admits work after ${release}`, async () => {
        const encoders = []
        encode.callsFake(() => {
          const encoder = new EventEmitter()
          encoders.push(encoder)
          return encoder
        })
        const upload = sinon.spy((filePath, index, uploaded) => uploaded())
        const complete = sinon.spy()
        for (let attempt = 0; attempt < 33; attempt++) {
          start().finish(true, upload, complete)
          await clock.tickAsync(0)
        }
        sinon.assert.calledOnce(encode)
        assert.ok(directories.every(directory => fs.existsSync(directory)))

        if (capture === 'multiremote') {
          Object.assign(browser, {
            isMultiremote: true,
            instances: ['first', 'second'],
            getInstance: () => ({ capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }),
          })
        }
        const rejected = start()
        const rejectedComplete = sinon.spy()
        rejected.finish(true, upload, rejectedComplete)
        await clock.tickAsync(0)
        sinon.assert.calledOnceWithExactly(rejectedComplete, 'error')
        assert.strictEqual(fs.existsSync(directories[33]), false)
        sinon.assert.calledOnce(encode)
        sinon.assert.notCalled(upload)
        rejected.cancel()
        sinon.assert.calledOnce(rejectedComplete)

        if (release === 'completion') encoders[0].emit('close', 0)
        else recorders[1].cancel()
        await clock.tickAsync(0)
        browser.isMultiremote = false
        start().finish(true, upload, complete)
        await clock.tickAsync(0)
        assert.strictEqual(fs.existsSync(directories[34]), true)
        sinon.assert.calledOnceWithExactly(complete, release === 'completion' ? 'uploaded' : 'error')

        for (let index = release === 'completion' ? 1 : 0; index < encoders.length; index++) {
          encoders[index].emit('close', 0)
          await clock.tickAsync(0)
        }
        assert.strictEqual(complete.callCount, 34)
        assert.strictEqual(upload.callCount, release === 'completion' ? 34 : 33)
        assert.strictEqual(encode.callCount, upload.callCount)
        assert.ok(directories.every(directory => !fs.existsSync(directory)))
        sinon.assert.calledOnce(rejectedComplete)
      })
    }
  }

  for (const bytes of [200 * 1024 * 1024, 200 * 1024 * 1024 + 1]) {
    it(`bounds retained encoder frames at ${bytes} bytes and releases the byte budget`, async () => {
      const encoders = []
      encode.callsFake(() => {
        const encoder = new EventEmitter()
        encoders.push(encoder)
        return encoder
      })
      const upload = sinon.spy((filePath, index, uploaded) => uploaded())
      const complete = sinon.spy()
      const firstFrame = Buffer.alloc(100 * 1024 * 1024)
      Buffer.from(PNG, 'base64').copy(firstFrame)
      browser.takeScreenshot.resolves(firstFrame.toString('base64'))
      const first = start()
      browser.takeScreenshot.rejects(new Error('session closed before final capture'))
      first.finish(true, upload, complete)
      await clock.tickAsync(0)

      const secondFrame = Buffer.alloc(bytes - firstFrame.length)
      firstFrame.copy(secondFrame)
      browser.takeScreenshot.resolves(secondFrame.toString('base64'))
      const second = start()
      browser.takeScreenshot.rejects(new Error('session closed before final capture'))
      second.finish(true, upload, complete)
      await clock.tickAsync(0)
      const accepted = bytes === 200 * 1024 * 1024
      assert.strictEqual(fs.existsSync(directories[1]), accepted)
      assert.strictEqual(complete.callCount, accepted ? 0 : 1)
      sinon.assert.calledOnce(encode)
      sinon.assert.notCalled(upload)

      if (accepted) second.cancel()
      else encoders[0].emit('close', 0)
      await clock.tickAsync(0)
      browser.takeScreenshot.resolves(secondFrame.toString('base64'))
      const next = start()
      browser.takeScreenshot.rejects(new Error('session closed before final capture'))
      next.finish(true, upload, complete)
      await clock.tickAsync(0)
      assert.strictEqual(fs.existsSync(directories[2]), true)

      for (let index = accepted ? 0 : 1; index < encoders.length; index++) {
        encoders[index].emit('close', 0)
        await clock.tickAsync(0)
      }
      assert.deepStrictEqual(complete.args, [['error'], ['uploaded'], ['uploaded']])
      sinon.assert.calledTwice(upload)
      sinon.assert.calledTwice(encode)
      assert.ok(directories.every(directory => !fs.existsSync(directory)))
    })
  }

  for (const sessions of [1, 2]) {
    for (const outcome of ['success', 'error', 'cancel']) {
      it(`retains the frame budget during a stalled ${sessions}-session upload until ${outcome}`, async () => {
        const frame = Buffer.alloc(200 * 1024 * 1024 / sessions)
        Buffer.from(PNG, 'base64').copy(frame)
        const screenshot = frame.toString('base64')
        const screenshots = sessions === 1 ? screenshot : [screenshot, screenshot]
        browser.takeScreenshot.resolves(screenshots)
        const upload = sinon.spy()
        const complete = sinon.spy()
        const recorder = start()
        browser.takeScreenshot.rejects(new Error('session closed before final capture'))
        recorder.finish(true, upload, complete)
        await clock.tickAsync(0)
        sinon.assert.calledOnce(upload)
        sinon.assert.notCalled(complete)
        assert.strictEqual(fs.existsSync(directories[0]), true)

        browser.takeScreenshot.resolves(PNG)
        const rejected = sinon.spy()
        start().finish(true, upload, rejected)
        await clock.tickAsync(0)
        sinon.assert.calledOnceWithExactly(rejected, 'error')
        sinon.assert.calledOnce(encode)
        sinon.assert.calledOnce(upload)
        assert.strictEqual(fs.existsSync(directories[1]), false)

        if (outcome === 'cancel') recorder.cancel()
        else {
          for (let index = 0; index < sessions; index++) {
            assert.strictEqual(fs.existsSync(directories[0]), true)
            upload.args[index][2](outcome === 'error' ? new Error('upload failed') : undefined)
            await clock.tickAsync(0)
          }
          assert.strictEqual(upload.callCount, sessions)
        }
        sinon.assert.calledOnceWithExactly(complete, outcome === 'success' ? 'uploaded' : 'error')
        assert.strictEqual(fs.existsSync(directories[0]), false)
        upload.firstCall.args[2]()
        recorder.cancel()
        sinon.assert.calledOnce(complete)

        browser.takeScreenshot.resolves(screenshots)
        const next = sinon.spy()
        const recovered = start()
        browser.takeScreenshot.rejects(new Error('session closed before final capture'))
        recovered.finish(true, (filePath, index, uploaded) => uploaded(), next)
        await clock.tickAsync(0)
        sinon.assert.calledOnceWithExactly(next, 'uploaded')
        assert.ok(directories.every(directory => !fs.existsSync(directory)))
      })
    }
  }

  for (const cleanupFails of [false, true]) {
    it(`accounts for a partial frame write when cleanup ${cleanupFails ? 'fails' : 'succeeds'}`, async () => {
      const frame = Buffer.alloc(200 * 1024 * 1024)
      Buffer.from(PNG, 'base64').copy(frame)
      browser.takeScreenshot.resolves(frame.toString('base64'))
      writeFrame.onFirstCall().callsFake((filePath, data) => {
        fs.writeFileSync(filePath, data.subarray(0, 24))
        throw new Error('disk write failed')
      })
      if (cleanupFails) removeFrames.onFirstCall().throws(new Error('cleanup failed'))
      const first = sinon.spy()
      start().finish(true, () => assert.fail('unexpected upload'), first)
      await clock.tickAsync(0)
      sinon.assert.calledOnceWithExactly(first, 'error')
      assert.strictEqual(fs.existsSync(directories[0]), cleanupFails)
      browser.takeScreenshot.resolves(PNG)
      const next = sinon.spy()
      start().finish(true, (filePath, index, uploaded) => uploaded(), next)
      await clock.tickAsync(0)
      sinon.assert.calledOnceWithExactly(next, cleanupFails ? 'error' : 'uploaded')
      assert.strictEqual(fs.existsSync(directories[1]), false)
    })
  }

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

  for (const cleanup of ['success', 'locked until close', 'permanent failure']) {
    for (const [stage, code] of [['encoder', 0], ['encoder', 1], ['upload', 0], ['upload', 1]]) {
      it(`retries cancelled ${stage} cleanup after outcome ${code}: ${cleanup}`, async () => {
        const encoder = Object.assign(new EventEmitter(), {
          kill: sinon.stub().returns(true),
          unref: sinon.spy(),
        })
        encode.onFirstCall().returns(encoder)
        const frame = Buffer.alloc(200 * 1024 * 1024)
        Buffer.from(PNG, 'base64').copy(frame)
        const screenshot = frame.toString('base64')
        // Account for the full frame without writing 200 MiB to disk in each case.
        writeFrame.callsFake((filePath, data) => fs.writeFileSync(filePath,
          Buffer.isBuffer(data) ? data.subarray(0, 24) : data))
        const locked = Object.assign(new Error('video file is locked'), { code: 'EBUSY' })
        if (cleanup !== 'success') removeFrames.onFirstCall().throws(locked)
        if (cleanup === 'permanent failure') removeFrames.onSecondCall().throws(locked)
        browser.takeScreenshot.resolves(screenshot)
        const recorder = start()
        browser.takeScreenshot.rejects(new Error('session closed before final capture'))
        const upload = sinon.spy()
        const complete = sinon.spy()
        recorder.finish(true, upload, complete)
        await clock.tickAsync(0)
        if (stage === 'upload') {
          encoder.emit('close', 0)
          await clock.tickAsync(0)
          sinon.assert.calledOnce(upload)
        }
        const settle = stage === 'encoder'
          ? () => encoder.emit('close', code)
          : () => upload.firstCall.args[2](code ? new Error('upload failed') : undefined)

        recorder.cancel()
        recorder.cancel()
        sinon.assert.calledOnceWithExactly(complete, 'error')
        if (stage === 'encoder') {
          sinon.assert.calledOnceWithExactly(encoder.kill, 'SIGKILL')
          sinon.assert.calledOnce(encoder.unref)
        } else {
          sinon.assert.notCalled(encoder.kill)
          sinon.assert.notCalled(encoder.unref)
        }
        sinon.assert.calledOnce(removeFrames)
        assert.strictEqual(fs.existsSync(directories[0]), cleanup !== 'success')

        settle()
        await clock.tickAsync(0)
        sinon.assert.calledOnce(complete)
        assert.strictEqual(upload.callCount, stage === 'encoder' ? 0 : 1)
        assert.strictEqual(fs.existsSync(directories[0]), cleanup === 'permanent failure')
        if (cleanup !== 'success') sinon.assert.calledTwice(removeFrames)
        const cleanupCalls = removeFrames.callCount
        settle()
        recorder.cancel()
        assert.strictEqual(removeFrames.callCount, cleanupCalls)
        sinon.assert.calledOnce(complete)
        upload.resetHistory()

        // A later watch run can use the entire budget only once deletion succeeds.
        browser.takeScreenshot.resolves(screenshot)
        const recovered = start()
        browser.takeScreenshot.rejects(new Error('session closed before final capture'))
        const next = sinon.spy()
        recovered.finish(true, upload, next)
        await clock.tickAsync(0)
        if (cleanup === 'permanent failure') {
          sinon.assert.calledOnceWithExactly(next, 'error')
          sinon.assert.notCalled(upload)
          return
        }
        sinon.assert.calledOnce(upload)
        sinon.assert.notCalled(next)

        // Repeated cleanup must not release the same bytes twice and inflate the budget.
        browser.takeScreenshot.resolves(PNG)
        const rejected = sinon.spy()
        start().finish(true, upload, rejected)
        await clock.tickAsync(0)
        sinon.assert.calledOnceWithExactly(rejected, 'error')
        sinon.assert.calledOnce(upload)
        upload.firstCall.args[2]()
        sinon.assert.calledOnceWithExactly(next, 'uploaded')
        sinon.assert.calledOnce(complete)
        assert.ok(directories.every(directory => !fs.existsSync(directory)))
      })
    }
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

  for (const flag of ['isMultiremote', 'isMultiRemote']) {
    it(`uses the standard screenshot command for mixed Classic and BiDi multiremote sessions (${flag})`, async () => {
      const classic = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
      const bidi = {
        capabilities: browser.capabilities,
        isBidi: true,
        browsingContextCaptureScreenshot: sinon.stub().throws(new Error('capture lost its context during navigation')),
        takeScreenshot: sinon.stub().resolves(PNG),
      }
      Object.assign(browser, {
        [flag]: true,
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
      sinon.assert.calledTwice(classic.takeScreenshot)
      sinon.assert.calledTwice(bidi.takeScreenshot)
      sinon.assert.notCalled(browser.takeScreenshot)
      sinon.assert.notCalled(bidi.browsingContextCaptureScreenshot)
      sinon.assert.calledTwice(upload)
      sinon.assert.calledOnceWithExactly(complete, 'uploaded')
    })
  }

  for (const capture of ['single', 'consecutive', 'multiremote']) {
    for (const bytes of [200 * 1024 * 1024, 200 * 1024 * 1024 + 1]) {
      it(`enforces the raw recording limit before decoding ${bytes} bytes across ${capture} captures`, async () => {
        const firstFrame = Buffer.from(PNG, 'base64')
        const frame = Buffer.alloc(bytes - (capture === 'single' ? 0 : firstFrame.length))
        firstFrame.copy(frame)
        const screenshot = frame.toString('base64')
        browser.takeScreenshot.resolves(screenshot)
        if (capture === 'single') {
          browser.takeScreenshot.onSecondCall().rejects(new Error('session closed before final capture'))
        }
        if (capture === 'consecutive') browser.takeScreenshot.onFirstCall().resolves(PNG)
        if (capture === 'multiremote') {
          const first = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
          const second = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(screenshot) }
          first.takeScreenshot.onSecondCall().rejects(new Error('session closed before final capture'))
          second.takeScreenshot.onSecondCall().rejects(new Error('session closed before final capture'))
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
        assert.strictEqual(Number(args[args.indexOf('-frames:v') + 1]), finalCapture ? 2 : 3)
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
    const first = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
    const second = { capabilities: browser.capabilities, takeScreenshot: sinon.stub().resolves(PNG) }
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
    assert.deepStrictEqual(frames, [[0, 2], [1, 2]])
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

  for (const failure of ['missing executable', 'nonzero status', 'startup throw', 'missing libvpx', 'VP9 only']) {
    it(`disables recording safely after FFmpeg preflight ${failure}`, () => {
      if (failure === 'missing executable') checkFfmpeg.returns({ error: new Error('ENOENT'), status: null })
      if (failure === 'nonzero status') checkFfmpeg.returns({ status: 1 })
      if (failure === 'startup throw') checkFfmpeg.throws(new Error('startup failed'))
      if (failure === 'missing libvpx') checkFfmpeg.returns({ status: 0, stdout: 'Encoders:\n' })
      if (failure === 'VP9 only') checkFfmpeg.returns({ status: 0, stdout: ' V....D libvpx-vp9 libvpx VP9\n' })
      assert.strictEqual(start(), undefined)
      sinon.assert.notCalled(browser.takeScreenshot)
      sinon.assert.notCalled(encode)
      assert.deepStrictEqual(directories, [])
      sinon.assert.calledOnce(failure === 'startup throw' ? log.error : log.warn)
      assert.strictEqual(start(), undefined)
      sinon.assert.calledOnce(checkFfmpeg)
      sinon.assert.calledOnce(log.warn)
    })
  }

  it('checks FFmpeg only once per WDIO process with a bounded preflight', () => {
    start()
    start()
    sinon.assert.calledOnceWithExactly(checkFfmpeg, 'ffmpeg', ['-hide_banner', '-encoders'], {
      timeout: 5000, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
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
    assert.strictEqual(args[args.indexOf('-frames:v') + 1], '3')
  })

  it('does no work before the browser exists', () => {
    assert.strictEqual(createVideo(undefined), undefined)
    sinon.assert.notCalled(encode)
    sinon.assert.notCalled(checkFfmpeg)
    assert.deepStrictEqual(directories, [])
  })
})
