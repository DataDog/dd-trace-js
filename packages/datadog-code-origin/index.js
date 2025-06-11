'use strict'

const { getUserLandFrames } = require('../dd-trace/src/plugins/util/stacktrace')

const ENTRY_SPAN_STACK_FRAMES_LIMIT = 1
const EXIT_SPAN_STACK_FRAMES_LIMIT = Number(process.env._DD_CODE_ORIGIN_FOR_SPANS_EXIT_SPAN_MAX_USER_FRAMES) || 8

module.exports = {
  entryTags,
  exitTags
}

/**
 * @param {Function} topOfStackFunc - A function present in the current stack, above which no stack frames should be
 *   collected.
 * @returns {Record<string, string>}
 */
function entryTags (topOfStackFunc) {
  return tag('entry', topOfStackFunc, ENTRY_SPAN_STACK_FRAMES_LIMIT)
}

/**
 * @param {Function} topOfStackFunc - A function present in the current stack, above which no stack frames should be
 *   collected.
 * @returns {Record<string, string>}
 */
function exitTags (topOfStackFunc) {
  return tag('exit', topOfStackFunc, EXIT_SPAN_STACK_FRAMES_LIMIT)
}

/**
 * @param {'entry'|'exit'} type - The type of code origin.
 * @param {Function} topOfStackFunc - A function present in the current stack, above which no stack frames should be
 *   collected.
 * @param {number} limit - The maximum number of stack frames to include in the tags.
 * @returns {Record<string, string>}
 */
function tag (type, topOfStackFunc, limit) {
  const frames = getUserLandFrames(topOfStackFunc, limit)
  const tags = {
    '_dd.code_origin.type': type
  }
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    tags[`_dd.code_origin.frames.${i}.file`] = frame.file
    tags[`_dd.code_origin.frames.${i}.line`] = String(frame.line)
    tags[`_dd.code_origin.frames.${i}.column`] = String(frame.column)
    if (frame.method) {
      tags[`_dd.code_origin.frames.${i}.method`] = frame.method
    }
    if (frame.type) {
      tags[`_dd.code_origin.frames.${i}.type`] = frame.type
    }
  }
  return tags
}
