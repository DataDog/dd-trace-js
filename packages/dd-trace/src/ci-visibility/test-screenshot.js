'use strict'

const { statSync } = require('node:fs')

const {
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
} = require('../plugins/util/test')

const dateNow = Date.now

const SCREENSHOT_UPLOAD_RESULT_UPLOADED = 'uploaded'
const SCREENSHOT_UPLOAD_RESULT_ERROR = 'error'

/**
 * Resolves a screenshot's capture time in epoch milliseconds.
 *
 * @param {object|string} screenshot - Framework screenshot metadata or its file path
 * @param {string} filePath - Resolved screenshot file path
 * @returns {number} Capture time in epoch milliseconds
 */
function getScreenshotCapturedAtMs (screenshot, filePath) {
  const takenAt = screenshot !== null && typeof screenshot === 'object' ? screenshot.takenAt : undefined
  if (takenAt) {
    const parsedMs = new Date(takenAt).getTime()
    if (Number.isInteger(parsedMs) && parsedMs > 0) {
      return parsedMs
    }
  }
  try {
    return Math.floor(statSync(filePath).mtimeMs)
  } catch {
    return dateNow()
  }
}

/**
 * Combines screenshot upload results, giving errors precedence over successes.
 *
 * @param {Array<string|undefined>} uploadResults - Per-screenshot upload results
 * @returns {string|undefined} Combined upload result
 */
function getScreenshotUploadResult (uploadResults) {
  let hasUploaded = false
  for (const uploadResult of uploadResults) {
    if (uploadResult === SCREENSHOT_UPLOAD_RESULT_ERROR) {
      return SCREENSHOT_UPLOAD_RESULT_ERROR
    }
    if (uploadResult === SCREENSHOT_UPLOAD_RESULT_UPLOADED) {
      hasUploaded = true
    }
  }
  return hasUploaded ? SCREENSHOT_UPLOAD_RESULT_UPLOADED : undefined
}

/**
 * Returns the test tag that represents an aggregate screenshot upload outcome.
 *
 * @param {string|undefined} uploadResult - Aggregate screenshot upload result
 * @returns {string|undefined} Screenshot upload result tag
 */
function getScreenshotUploadTag (uploadResult) {
  if (uploadResult === SCREENSHOT_UPLOAD_RESULT_ERROR) {
    return TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR
  }
  if (uploadResult === SCREENSHOT_UPLOAD_RESULT_UPLOADED) {
    return TEST_FAILURE_SCREENSHOT_UPLOADED
  }
}

/**
 * Tags a test span with the aggregate screenshot upload outcome.
 *
 * @param {object} testSpan - Test span to tag
 * @param {string|undefined} uploadResult - Aggregate screenshot upload result
 * @returns {void}
 */
function setScreenshotUploadTags (testSpan, uploadResult) {
  const uploadTag = getScreenshotUploadTag(uploadResult)
  if (uploadTag) testSpan.setTag(uploadTag, 'true')
}

module.exports = {
  SCREENSHOT_UPLOAD_RESULT_ERROR,
  SCREENSHOT_UPLOAD_RESULT_UPLOADED,
  getScreenshotCapturedAtMs,
  getScreenshotUploadResult,
  getScreenshotUploadTag,
  setScreenshotUploadTags,
}
