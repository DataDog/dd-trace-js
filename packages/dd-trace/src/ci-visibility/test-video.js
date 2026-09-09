'use strict'

const {
  TEST_FAILURE_VIDEO_SCOPE,
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
} = require('../plugins/util/test')

const VIDEO_UPLOAD_RESULT_UPLOADED = 'uploaded'
const VIDEO_UPLOAD_RESULT_ERROR = 'error'
const VIDEO_UPLOAD_SCOPE_TEST_SUITE = 'test_suite'

/**
 * Combines video upload results, giving errors precedence over successes.
 *
 * @param {Array<string|undefined>} uploadResults - Per-video upload results
 * @returns {string|undefined} Combined upload result
 */
function getVideoUploadResult (uploadResults) {
  let hasUploaded = false
  for (const uploadResult of uploadResults) {
    if (uploadResult === VIDEO_UPLOAD_RESULT_ERROR) return VIDEO_UPLOAD_RESULT_ERROR
    if (uploadResult === VIDEO_UPLOAD_RESULT_UPLOADED) hasUploaded = true
  }
  return hasUploaded ? VIDEO_UPLOAD_RESULT_UPLOADED : undefined
}

/**
 * Returns the tag that represents an aggregate video upload outcome.
 *
 * @param {string|undefined} uploadResult - Aggregate video upload result
 * @returns {string|undefined} Video upload result tag
 */
function getVideoUploadTag (uploadResult) {
  if (uploadResult === VIDEO_UPLOAD_RESULT_ERROR) return TEST_FAILURE_VIDEO_UPLOAD_ERROR
  if (uploadResult === VIDEO_UPLOAD_RESULT_UPLOADED) return TEST_FAILURE_VIDEO_UPLOADED
}

/**
 * Tags a test or test suite span with its video upload outcome and optional scope.
 *
 * @param {object} span - Test or test suite span to tag
 * @param {string|undefined} uploadResult - Aggregate video upload result
 * @param {string} [scope] - Media lookup scope
 * @returns {void}
 */
function setVideoUploadTags (span, uploadResult, scope) {
  const uploadTag = getVideoUploadTag(uploadResult)
  if (!uploadTag) return
  span.setTag(uploadTag, 'true')
  if (scope) span.setTag(TEST_FAILURE_VIDEO_SCOPE, scope)
}

module.exports = {
  VIDEO_UPLOAD_RESULT_ERROR,
  VIDEO_UPLOAD_RESULT_UPLOADED,
  VIDEO_UPLOAD_SCOPE_TEST_SUITE,
  getVideoUploadResult,
  getVideoUploadTag,
  setVideoUploadTags,
}
