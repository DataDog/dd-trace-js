'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const {
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
} = require('../../src/plugins/util/test')

describe('test screenshot helpers', () => {
  let clock
  let statSync
  let screenshotHelpers

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1_700_000_000_000 })
    statSync = sinon.stub()
    screenshotHelpers = proxyquire('../../src/ci-visibility/test-screenshot', {
      'node:fs': { statSync },
    })
  })

  afterEach(() => {
    clock.restore()
    sinon.restore()
  })

  it('uses framework capture metadata before the file modification time', () => {
    const capturedAtMs = screenshotHelpers.getScreenshotCapturedAtMs(
      { takenAt: '2024-01-02T03:04:05.678Z' },
      '/tmp/screenshot.png'
    )

    assert.strictEqual(capturedAtMs, 1_704_164_645_678)
    sinon.assert.notCalled(statSync)
  })

  it('uses the file modification time when capture metadata is unavailable', () => {
    statSync.returns({ mtimeMs: 1_704_164_645_678.9 })

    assert.strictEqual(
      screenshotHelpers.getScreenshotCapturedAtMs('/tmp/screenshot.png', '/tmp/screenshot.png'),
      1_704_164_645_678
    )
  })

  it('uses the file modification time when capture metadata is invalid', () => {
    statSync.returns({ mtimeMs: 1_704_164_645_678 })

    assert.strictEqual(
      screenshotHelpers.getScreenshotCapturedAtMs({ takenAt: 'invalid' }, '/tmp/screenshot.png'),
      1_704_164_645_678
    )
  })

  it('uses the current time when the screenshot file cannot be inspected', () => {
    statSync.throws(new Error('missing'))

    assert.strictEqual(
      screenshotHelpers.getScreenshotCapturedAtMs('/tmp/screenshot.png', '/tmp/screenshot.png'),
      1_700_000_000_000
    )
  })

  it('gives upload errors precedence over successful uploads', () => {
    const { SCREENSHOT_UPLOAD_RESULT_ERROR, SCREENSHOT_UPLOAD_RESULT_UPLOADED } = screenshotHelpers

    assert.strictEqual(
      screenshotHelpers.getScreenshotUploadResult([
        SCREENSHOT_UPLOAD_RESULT_UPLOADED,
        SCREENSHOT_UPLOAD_RESULT_ERROR,
      ]),
      SCREENSHOT_UPLOAD_RESULT_ERROR
    )
    assert.strictEqual(
      screenshotHelpers.getScreenshotUploadResult([undefined, SCREENSHOT_UPLOAD_RESULT_UPLOADED]),
      SCREENSHOT_UPLOAD_RESULT_UPLOADED
    )
    assert.strictEqual(screenshotHelpers.getScreenshotUploadResult([undefined]), undefined)
  })

  it('tags successful and failed screenshot uploads', () => {
    const { SCREENSHOT_UPLOAD_RESULT_ERROR, SCREENSHOT_UPLOAD_RESULT_UPLOADED } = screenshotHelpers
    const testSpan = { setTag: sinon.spy() }

    assert.strictEqual(
      screenshotHelpers.getScreenshotUploadTag(SCREENSHOT_UPLOAD_RESULT_UPLOADED),
      TEST_FAILURE_SCREENSHOT_UPLOADED
    )
    assert.strictEqual(
      screenshotHelpers.getScreenshotUploadTag(SCREENSHOT_UPLOAD_RESULT_ERROR),
      TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR
    )
    assert.strictEqual(screenshotHelpers.getScreenshotUploadTag(undefined), undefined)

    screenshotHelpers.setScreenshotUploadTags(testSpan, SCREENSHOT_UPLOAD_RESULT_UPLOADED)
    screenshotHelpers.setScreenshotUploadTags(testSpan, SCREENSHOT_UPLOAD_RESULT_ERROR)

    assert.deepStrictEqual(testSpan.setTag.args, [
      [TEST_FAILURE_SCREENSHOT_UPLOADED, 'true'],
      [TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR, 'true'],
    ])
  })
})
