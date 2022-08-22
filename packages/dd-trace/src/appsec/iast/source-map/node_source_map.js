// This file is a modified version of:
// https://github.com/nodejs/node/blob/5e57d24d325f0aea74394f78ebdc06857cca77b1/lib/internal/source_map/source_map.js
// from the NodeJs codebase

// This file is a modified version of:
// https://cs.chromium.org/chromium/src/v8/tools/SourceMap.js?rcl=dd10454c1d
// from the V8 codebase. Logic specific to WebInspector is removed and linting
// is made to match the Node.js style guide.

// Copyright 2013 the V8 project authors. All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above
//       copyright notice, this list of conditions and the following
//       disclaimer in the documentation and/or other materials provided
//       with the distribution.
//     * Neither the name of Google Inc. nor the names of its
//       contributors may be used to endorse or promote products derived
//       from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// This is a copy from blink dev tools, see:
// http://src.chromium.org/viewvc/blink/trunk/Source/devtools/front_end/SourceMap.js
// revision: 153407

/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict'

const {
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSort,
  ArrayIsArray,
  ObjectPrototypeHasOwnProperty,
  StringPrototypeCharAt
} = require('./primordials')

const validateObject = function () {}
let base64Map

const VLQ_BASE_SHIFT = 5
const VLQ_BASE_MASK = (1 << 5) - 1
const VLQ_CONTINUATION_MASK = 1 << 5

class StringCharIterator {
  /**
   * @constructor
   * @param {string} string
   */
  constructor (string) {
    this._string = string
    this._position = 0
  }

  /**
   * @return {string}
   */
  next () {
    return StringPrototypeCharAt(this._string, this._position++)
  }

  /**
   * @return {string}
   */
  peek () {
    return StringPrototypeCharAt(this._string, this._position)
  }

  /**
   * @return {boolean}
   */
  hasNext () {
    return this._position < this._string.length
  }
}

/**
 * Implements Source Map V3 model.
 * See https://github.com/google/closure-compiler/wiki/Source-Maps
 * for format description.
 */
class SourceMap {
  /**
   * @constructor
   * @param {SourceMapV3} payload
   */
  constructor (payload) {
    this._mappings = []
    this._sources = {}
    this._sources = {}
    if (!base64Map) {
      const base64Digits =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      base64Map = {}
      for (let i = 0; i < base64Digits.length; ++i) {
        base64Map[base64Digits[i]] = i
      }
    }
    this._payload = cloneSourceMapV3(payload)
    this._parseMappingPayload()
  }

  _parseMappingPayload () {
    if (this._payload.sections) {
      this._parseSections(this._payload.sections)
    } else {
      this._parseMap(this._payload, 0, 0)
    }
    ArrayPrototypeSort(this._mappings, compareSourceMapEntry)
  }

  /**
   * @param {Array.<SourceMapV3.Section>} sections
   */
  _parseSections (sections) {
    for (let i = 0; i < sections.length; ++i) {
      const section = sections[i]
      this._parseMap(section.map, section.offset.line, section.offset.column)
    }
  }

  /**
   * @param {number} lineNumber in compiled resource
   * @param {number} columnNumber in compiled resource
   * @return {?Array}
   */
  findEntry (lineNumber, columnNumber) {
    let first = 0
    let count = this._mappings.length
    while (count > 1) {
      const step = count >> 1
      const middle = first + step
      const mapping = this._mappings[middle]
      if (lineNumber < mapping[0] ||
        (lineNumber === mapping[0] && columnNumber < mapping[1])) {
        count = step
      } else {
        first = middle
        count -= step
      }
    }
    const entry = this._mappings[first]
    if (!first && entry && (lineNumber < entry[0] ||
      (lineNumber === entry[0] && columnNumber < entry[1]))) {
      return {}
    } else if (!entry) {
      return {}
    }
    return {
      generatedLine: entry[0],
      generatedColumn: entry[1],
      originalSource: entry[2],
      originalLine: entry[3],
      originalColumn: entry[4],
      name: entry[5]
    }
  }

  /**
   * @override
   */
  _parseMap (map, lineNumber, columnNumber) {
    let sourceIndex = 0
    let sourceLineNumber = 0
    let sourceColumnNumber = 0
    let nameIndex = 0

    const sources = []
    const originalToCanonicalURLMap = {}
    for (let i = 0; i < map.sources.length; ++i) {
      const url = map.sources[i]
      originalToCanonicalURLMap[url] = url
      ArrayPrototypePush(sources, url)
      this._sources[url] = true

      if (map.sourcesContent && map.sourcesContent[i]) {
        this._sources[url] = map.sourcesContent[i]
      }
    }

    const stringCharIterator = new StringCharIterator(map.mappings)
    let sourceURL = sources[sourceIndex]
    while (true) {
      if (stringCharIterator.peek() === ',') {
        stringCharIterator.next()
      } else {
        while (stringCharIterator.peek() === ';') {
          lineNumber += 1
          columnNumber = 0
          stringCharIterator.next()
        }
        if (!stringCharIterator.hasNext()) {
          break
        }
      }

      columnNumber += decodeVLQ(stringCharIterator)
      if (isSeparator(stringCharIterator.peek())) {
        ArrayPrototypePush(this._mappings, [lineNumber, columnNumber])
        continue
      }

      const sourceIndexDelta = decodeVLQ(stringCharIterator)
      if (sourceIndexDelta) {
        sourceIndex += sourceIndexDelta
        sourceURL = sources[sourceIndex]
      }
      sourceLineNumber += decodeVLQ(stringCharIterator)
      sourceColumnNumber += decodeVLQ(stringCharIterator)

      let name
      if (!isSeparator(stringCharIterator.peek())) {
        nameIndex += decodeVLQ(stringCharIterator)
        name = map.names ? map.names[nameIndex] : undefined
      }

      ArrayPrototypePush(
        this._mappings,
        [lineNumber, columnNumber, sourceURL, sourceLineNumber,
          sourceColumnNumber, name]
      )
    }
  }
}

/**
 * @param {string} char
 * @return {boolean}
 */
function isSeparator (char) {
  return char === ',' || char === ';'
}

/**
 * @param {SourceMap.StringCharIterator} stringCharIterator
 * @return {number}
 */
function decodeVLQ (stringCharIterator) {
  // Read unsigned value.
  let result = 0
  let shift = 0
  let digit
  do {
    digit = base64Map[stringCharIterator.next()]
    result += (digit & VLQ_BASE_MASK) << shift
    shift += VLQ_BASE_SHIFT
  } while (digit & VLQ_CONTINUATION_MASK)

  // Fix the sign.
  const negative = result & 1
  // Use unsigned right shift, so that the 32nd bit is properly shifted to the
  // 31st, and the 32nd becomes unset.
  result >>>= 1
  if (!negative) {
    return result
  }

  // We need to OR here to ensure the 32nd bit (the sign bit in an Int32) is
  // always set for negative numbers. If `result` were 1, (meaning `negate` is
  // true and all other bits were zeros), `result` would now be 0. But -0
  // doesn't flip the 32nd bit as intended. All other numbers will successfully
  // set the 32nd bit without issue, so doing this is a noop for them.
  return -result | (1 << 31)
}

/**
 * @param {SourceMapV3} payload
 * @return {SourceMapV3}
 */
function cloneSourceMapV3 (payload) {
  validateObject(payload, 'payload')
  payload = { ...payload }
  for (const key in payload) {
    if (ObjectPrototypeHasOwnProperty(payload, key) &&
      ArrayIsArray(payload[key])) {
      payload[key] = ArrayPrototypeSlice(payload[key])
    }
  }
  return payload
}

/**
 * @param {Array} entry1 source map entry [lineNumber, columnNumber, sourceURL,
 *  sourceLineNumber, sourceColumnNumber]
 * @param {Array} entry2 source map entry.
 * @return {number}
 */
function compareSourceMapEntry (entry1, entry2) {
  const { 0: lineNumber1, 1: columnNumber1 } = entry1
  const { 0: lineNumber2, 1: columnNumber2 } = entry2
  if (lineNumber1 !== lineNumber2) {
    return lineNumber1 - lineNumber2
  }
  return columnNumber1 - columnNumber2
}

module.exports = {
  SourceMap
}
