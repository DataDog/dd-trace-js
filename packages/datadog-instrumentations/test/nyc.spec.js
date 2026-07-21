'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { after, afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const { channel } = require('../src/helpers/instrument')

const reportChannel = channel('ci:nyc:report')

describe('nyc instrumentation', () => {
  let NYC
  let originalMethods
  let previousSettingsCachePath
  let reportSubscriber
  let tempDirectory

  before(() => {
    previousSettingsCachePath = process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
    NYC = require('nyc')
    originalMethods = {
      getCoverageMapFromAllCoverageFiles: NYC.prototype.getCoverageMapFromAllCoverageFiles,
      report: NYC.prototype.report,
      wrap: NYC.prototype.wrap,
    }

    const realInstrument = require('../src/helpers/instrument')
    const addHook = sinon.spy()
    proxyquire('../src/nyc', {
      './helpers/instrument': { ...realInstrument, addHook },
    })
    let nycHook
    for (const { args } of addHook.getCalls()) {
      if (args[0].name === 'nyc') {
        nycHook = args[1]
        break
      }
    }
    nycHook(NYC)
  })

  afterEach(async () => {
    reportChannel.unsubscribe(reportSubscriber)
    reportSubscriber = undefined
    sinon.restore()
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true })
      tempDirectory = undefined
    }
  })

  after(() => {
    Object.assign(NYC.prototype, originalMethods)
    if (previousSettingsCachePath === undefined) {
      delete process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
    } else {
      process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE = previousSettingsCachePath
    }
  })

  /**
   * @param {import('node:diagnostics_channel').ChannelListener} subscriber
   */
  function subscribe (subscriber) {
    reportSubscriber = subscriber
    reportChannel.subscribe(subscriber)
  }

  it('preserves report rejection with coverage upload enabled', async () => {
    const sentinelError = new Error('report failed')
    const nyc = new NYC({ reporter: [] })
    sinon.stub(nyc, 'getCoverageMapFromAllCoverageFiles').rejects(sentinelError)
    subscribe(sinon.stub())

    /**
     * @param {Error} error
     */
    function isSentinelError (error) {
      return error === sentinelError
    }

    await assert.rejects(nyc.report(), isSentinelError)
  })

  it('waits for coverage upload after a successful report', async () => {
    tempDirectory = await mkdtemp(path.join(tmpdir(), 'dd-trace-nyc-'))
    const nyc = new NYC({ reporter: [], tempDir: tempDirectory })

    const uploadObserved = new EventEmitter()
    let finishUpload
    let settled = false

    /**
     * @param {{ rootDir: string, onDone: () => void }} report
     */
    function holdUpload ({ rootDir, onDone }) {
      assert.strictEqual(rootDir, nyc.cwd)
      finishUpload = onDone
      uploadObserved.emit('report')
    }

    function markSettled () {
      settled = true
    }

    subscribe(holdUpload)

    const reportPromise = nyc.report().then(markSettled)
    await once(uploadObserved, 'report')

    assert.strictEqual(settled, false)
    finishUpload()
    await reportPromise

    assert.strictEqual(settled, true)
  })
})
