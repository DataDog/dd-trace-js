'use strict'

const { getUserLandFrames } = require('./plugins/util/stacktrace')

const limit = Number(process.env._DD_CODE_ORIGIN_MAX_USER_FRAMES) || 8

module.exports = {
  entryTag,
  exitTag
}

function entryTag (topOfStackFunc) {
  return tag('entry', topOfStackFunc)
}

function exitTag (topOfStackFunc) {
  return tag('exit', topOfStackFunc)
}

function tag (type, topOfStackFunc) {
  const frames = getUserLandFrames(topOfStackFunc, limit)
  const tags = {
    '_dd.code_origin.type': type
  }
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    tags[`_dd.code_origin.frames.${i}.file`] = frame.file
    tags[`_dd.code_origin.frames.${i}.line`] = String(frame.line)
    if (frame.method) {
      tags[`_dd.code_origin.frames.${i}.method`] = frame.method
    }
    if (frame.type) {
      tags[`_dd.code_origin.frames.${i}.type`] = frame.type
    }
  }
  return tags
}
