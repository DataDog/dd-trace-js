'use strict'

const { truncateSpan, normalizeSpan } = require('./tags-processors')
const { AgentEncoder: BaseEncoder } = require('./0.4')

const ARRAY_OF_TWO = 0x92
const ARRAY_OF_TWELVE = 0x9c

function formatSpan (span) {
  return normalizeSpan(truncateSpan(span, false))
}

function spanLinkToString (formattedLink) {
  let encoded = `{`
  // zero padded hex is done in accordance with RFC
  for (const [key, value] of Object.entries(formattedLink)) {
    if (key === 'trace_id_high') continue
    else if (key === 'trace_id') {
      const rootTid = formattedLink.trace_id_high
        ? formattedLink.trace_id_high.toString(16).padStart(16, '0') : '0000000000000000'
      const traceIdValue = value.toString(16).padStart(16, '0')
      encoded += `"${key}":"${rootTid}${traceIdValue}",`
    } else if (key === 'span_id') {
      encoded += `"${key}":"${value.toString(16).padStart(16, '0')}",`
    } else if (key === 'attributes') encoded += `"${key}":${JSON.stringify(value)},`
    else if (key === 'flags') {
      encoded += value === 0 ? `"${key}":${0},` : `"${key}":${1},`
    } else encoded += `"${key}":"${value}",`
  }

  return encoded.slice(0, -1) + '}' + ','
}

class AgentEncoder extends BaseEncoder {
  makePayload () {
    const prefixSize = 1
    const stringSize = this._stringBytes.length + 5
    const traceSize = this._traceBytes.length + 5
    const buffer = Buffer.allocUnsafe(prefixSize + stringSize + traceSize)

    let offset = 0

    buffer[offset++] = ARRAY_OF_TWO

    offset = this._writeStrings(buffer, offset)
    offset = this._writeTraces(buffer, offset)

    this._reset()

    return buffer
  }

  _encode (bytes, trace) {
    this._encodeArrayPrefix(bytes, trace)

    for (let span of trace) {
      span = formatSpan(span)
      this._encodeByte(bytes, ARRAY_OF_TWELVE)
      this._encodeString(bytes, span.service)
      this._encodeString(bytes, span.name)
      this._encodeString(bytes, span.resource)
      this._encodeId(bytes, span.trace_id)
      this._encodeId(bytes, span.span_id)
      this._encodeId(bytes, span.parent_id)
      this._encodeLong(bytes, span.start || 0)
      this._encodeLong(bytes, span.duration || 0)
      this._encodeInteger(bytes, span.error)
      if (span.links && span.links.length > 0) {
        span.links = this._formatSpanLinks(span)
        span.meta['_dd.span_links'] = span.links
      }
      this._encodeMap(bytes, span.meta || {})
      this._encodeMap(bytes, span.metrics || {})
      this._encodeString(bytes, span.type)
    }
  }

  _formatSpanLinks (span) {
    let links = '['
    for (const link of span.links) {
      links += spanLinkToString(link)
    }

    links = (links.length > 1 ? links.slice(0, -1) : links) + ']'
    return links
  }

  _encodeString (bytes, value = '') {
    this._cacheString(value)
    this._encodeInteger(bytes, this._stringMap[value])
  }

  _cacheString (value) {
    if (!(value in this._stringMap)) {
      this._stringMap[value] = this._stringCount++
      this._stringBytes.write(value)
    }
  }

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }
}

module.exports = { AgentEncoder }
