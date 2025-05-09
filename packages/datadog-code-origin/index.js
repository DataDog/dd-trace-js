'use strict'

const { getUserLandFrames } = require('../dd-trace/src/plugins/util/stacktrace')

const limit = Number(process.env._DD_CODE_ORIGIN_MAX_USER_FRAMES) || 8

module.exports = {
  entryTags,
  exitTags
}

function entryTags (topOfStackFunc, stackOffset = 0) {
  return tag('entry', topOfStackFunc, stackOffset)
}

function exitTags (topOfStackFunc) {
  return tag('exit', topOfStackFunc)
}

function tag (type, topOfStackFunc, stackOffset = 0) {
  const frames = getUserLandFrames(topOfStackFunc, limit)
  const tags = {
    '_dd.code_origin.type': type
  }
  for (let i = stackOffset; i < frames.length; i++) {
    const frame = frames[i]
    tags[`_dd.code_origin.frames.${i - stackOffset}.file`] = frame.file
    tags[`_dd.code_origin.frames.${i - stackOffset}.line`] = String(frame.line)
    tags[`_dd.code_origin.frames.${i - stackOffset}.column`] = String(frame.column)
    if (frame.method) {
      tags[`_dd.code_origin.frames.${i - stackOffset}.method`] = frame.method
    }
    if (frame.type) {
      tags[`_dd.code_origin.frames.${i - stackOffset}.type`] = frame.type
    }
  }
  return tags
}
