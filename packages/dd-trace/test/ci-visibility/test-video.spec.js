'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

const {
  TEST_FAILURE_VIDEO_SCOPE,
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
} = require('../../src/plugins/util/test')
const {
  VIDEO_UPLOAD_RESULT_ERROR,
  VIDEO_UPLOAD_RESULT_UPLOADED,
  VIDEO_UPLOAD_SCOPE_TEST_SUITE,
  getVideoUploadResult,
  getVideoUploadTag,
  setVideoUploadTags,
} = require('../../src/ci-visibility/test-video')

describe('test video helpers', () => {
  it('gives upload errors precedence over successful uploads', () => {
    assert.strictEqual(
      getVideoUploadResult([VIDEO_UPLOAD_RESULT_UPLOADED, VIDEO_UPLOAD_RESULT_ERROR]),
      VIDEO_UPLOAD_RESULT_ERROR
    )
    assert.strictEqual(
      getVideoUploadResult([undefined, VIDEO_UPLOAD_RESULT_UPLOADED]),
      VIDEO_UPLOAD_RESULT_UPLOADED
    )
    assert.strictEqual(getVideoUploadResult([undefined]), undefined)
  })

  it('returns the matching upload result tag', () => {
    assert.strictEqual(getVideoUploadTag(VIDEO_UPLOAD_RESULT_UPLOADED), TEST_FAILURE_VIDEO_UPLOADED)
    assert.strictEqual(getVideoUploadTag(VIDEO_UPLOAD_RESULT_ERROR), TEST_FAILURE_VIDEO_UPLOAD_ERROR)
    assert.strictEqual(getVideoUploadTag(undefined), undefined)
  })

  it('tags a test-scoped video without a scope override', () => {
    const span = { setTag: sinon.spy() }

    setVideoUploadTags(span, VIDEO_UPLOAD_RESULT_UPLOADED)

    sinon.assert.calledOnceWithExactly(span.setTag, TEST_FAILURE_VIDEO_UPLOADED, 'true')
  })

  it('tags a suite-scoped video outcome and its lookup scope', () => {
    const span = { setTag: sinon.spy() }

    setVideoUploadTags(span, VIDEO_UPLOAD_RESULT_ERROR, VIDEO_UPLOAD_SCOPE_TEST_SUITE)

    assert.deepStrictEqual(span.setTag.args, [
      [TEST_FAILURE_VIDEO_UPLOAD_ERROR, 'true'],
      [TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE],
    ])
  })

  it('does not set scope when no upload was attempted', () => {
    const span = { setTag: sinon.spy() }

    setVideoUploadTags(span, undefined, VIDEO_UPLOAD_SCOPE_TEST_SUITE)

    sinon.assert.notCalled(span.setTag)
  })
})
