'use strict'

const Chunk = require('../../../../packages/dd-trace/src/encode/chunk')
const { Client } = require('./client')
const { zeroId } = require('./id')
const { now } = require('./now')

// const service = process.env.DD_SERVICE || 'unnamed-node-app'
const ARRAY_OF_TWO = 0x92
const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB
const MAX_COLUMN_LENGTH = 65536
const flushInterval = 2000
const noop = () => {}
const eventTypes = {
  WEB_REQUEST_START: 1,
  ERROR: 2,
  WEB_REQUEST_FINISH: 3,
  START_SPAN: 4,
  FINISH_SPAN: 5,
  ADD_TAGS: 6,
  MYSQL_START_SPAN: 8
}
const columns = {
  type: new Int8Array(),
  time: new BigUint64Array(),
  traceId: new BigUint64Array(),
  spanId: new BigUint64Array(),
  parentId: new BigUint64Array(),
  component: new Uint16Array(),
  http_method: new Uint16Array(),
  http_route: new Uint16Array(),
  http_url: new Uint16Array(),
  http_status: new Uint16Array(),
  error_name: new Uint16Array(),
  error_message: new Uint16Array(),
  error_type: new Uint16Array(),
  sql_query: new Uint16Array(),
  sql_db: new Uint16Array(),
  sql_user: new Uint16Array(),
  sql_host: new Uint16Array(),
  sql_port: new Uint16Array()
}

let columnIndex = 0

const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

class Encoder {
  constructor (limit = SOFT_LIMIT) {
    this._limit = limit
    this._metadataBytes = new Chunk(1024)
    this._eventBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._client = new Client()
    this._reset()

    process.once('beforeExit', () => this.flush())
  }

  count () {
    return this._eventCount
  }

  encodeWebRequestStart (req, component, traceContext) {
    if (!traceContext) return

    columns.type[columnIndex] = eventTypes.WEB_REQUEST_START
    columns.time[columnIndex] = now()
    columns.traceId[columnIndex] = traceContext.traceId
    columns.spanId[columnIndex] = traceContext.spanId
    columns.parentId[columnIndex] = traceContext.parentId || 0n
    columns.component[columnIndex] = this._cacheString(component)
    columns.http_method[columnIndex] = this._cacheString(req.method)
    columns.http_url[columnIndex] = this._cacheString(req.url)
    columns.http_route[columnIndex] = this._cacheString(req.url)

    this._afterEncode()
  }

  encodeWebRequestFinish (res, traceContext) {
    if (!traceContext) return

    columns.type[columnIndex] = eventTypes.WEB_REQUEST_FINISH
    columns.time[columnIndex] = now()
    columns.traceId[columnIndex] = traceContext.traceId
    columns.spanId[columnIndex] = traceContext.spanId
    columns.http_status[columnIndex] = this._cacheString(res.statusCode)

    this._afterEncode()
  }

  encodeMysqlQueryStart (query, traceContext) {
    if (!traceContext) return

    columns.type[columnIndex] = eventTypes.MYSQL_START_SPAN
    columns.time[columnIndex] = now()
    columns.traceId[columnIndex] = traceContext.traceId
    columns.spanId[columnIndex] = traceContext.spanId
    columns.parentId[columnIndex] = traceContext.parentId || 0n
    columns.sql_query[columnIndex] = query.sql
    columns.sql_db[columnIndex] = query.database
    columns.sql_user[columnIndex] = query.user
    columns.sql_host[columnIndex] = query.host
    columns.sql_port[columnIndex] = query.port

    this._afterEncode()
  }

  encodeFinish (traceContext) {
    if (!traceContext) return

    columns.type[columnIndex] = eventTypes.FINISH_SPAN
    columns.time[columnIndex] = now()
    columns.traceId[columnIndex] = traceContext.traceId
    columns.spanId[columnIndex] = traceContext.spanId

    this._afterEncode()
  }

  encodeError (error, traceContext) {
    if (!traceContext) return // TODO: support errors without tracing

    columns.type[columnIndex] = eventTypes.ERROR
    columns.traceId[columnIndex] = traceContext.traceId
    columns.spanId[columnIndex] = traceContext.spanId

    if (error) {
      columns.error_name[columnIndex] = this._cacheString(error.name)
      columns.error_message[columnIndex] = this._cacheString(error.message)
      columns.error_stack[columnIndex] = this._cacheString(error.stack)
    }

    this._afterEncode()
  }

  makePayload () {
    const prefixSize = 1
    const stringSize = this._stringBytes.length + 5
    const eventSize = this._eventBytes.length + 5
    const buffer = Buffer.allocUnsafe(prefixSize + stringSize + eventSize)

    let offset = 0

    buffer[offset++] = ARRAY_OF_TWO

    offset = this._writeStrings(buffer, offset)
    // TODO: add metadata
    offset = this._writeEvents(buffer, offset)

    this._reset()

    return buffer
  }

  flush (done = noop) {
    const count = this.count()

    if (count === 0) return

    // const data = this.makePayload()

    this._timer = clearTimeout(this._timer)

    done()
  }

  // TODO: Use node:ffi when it lands.
  // https://github.com/nodejs/node/pull/46905
  flushFfi (data, done) {
    try {
      const path = require('path')
      const { getNativeFunction, getBufferPointer } = require('sbffi')
      const libPath = path.normalize(
        path.join(__dirname, '../../../../collector/target/release/libffi.dylib')
      )
      const submit = getNativeFunction(libPath, 'submit', 'uint32_t', ['uint32_t', 'uint8_t *'])
      const ptr = getBufferPointer(data)

      submit(data.length, ptr)
      done()
    } catch (e) {
      done(e)
    }
  }

  // In collector folder:
  // cargo build -r -p wasm --target wasm32-unknown-unknown
  // wasm-bindgen
  //   --target nodejs ./target/wasm32-unknown-unknown/release/wasm.wasm
  //   --out-dir=./target/wasm32-unknown-unknown/release/
  flushWasm (payload, done) {
    const libPath = '../../../../collector/target/wasm32-unknown-unknown/release/wasm.js'
    const { collect } = require(libPath)

    const data = collect(payload)
    const path = `/v0.5/traces`

    this._client.request({ data, path, port: 8126 }, done)
  }

  reset () {
    this._reset()
  }

  _afterEncode () {
    this._eventCount++

    columnIndex++

    // TODO: size limit by calculating columns
    if (columnIndex > MAX_COLUMN_LENGTH) {
      this.flush()
    } else if (!this._timer) {
      this._timer = setTimeout(() => this.flush(), flushInterval).unref()
    }
  }

  _reset () {
    this._metadataBytes.length = 0
    this._eventCount = 0
    this._eventBytes.length = 0
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = {}

    for (const key in columns) {
      columns[key].fill(columns[key].BYTES_PER_ELEMENT < 8 ? 0 : 0n)
    }

    columnIndex = 0

    this._cacheString('')
  }

  _encodeFixArray (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.length += 1

    bytes.buffer[offset] = 0x90 + size
  }

  _encodeArrayPrefix (bytes, value) {
    const length = value.length
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    bytes.buffer[offset] = 0xdd
    bytes.buffer[offset + 1] = length >> 24
    bytes.buffer[offset + 2] = length >> 16
    bytes.buffer[offset + 3] = length >> 8
    bytes.buffer[offset + 4] = length
  }

  _encodeFixMap (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.length += 1

    bytes.buffer[offset] = 0x80 + size
  }

  _encodeMapPrefix (bytes, keysLength) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5
    bytes.buffer[offset] = 0xdf
    bytes.buffer[offset + 1] = keysLength >> 24
    bytes.buffer[offset + 2] = keysLength >> 16
    bytes.buffer[offset + 3] = keysLength >> 8
    bytes.buffer[offset + 4] = keysLength
  }

  _encodeByte (bytes, value) {
    bytes.reserve(1)

    bytes.buffer[bytes.length++] = value
  }

  _encodeId (bytes, id) {
    const offset = bytes.length

    if (id === zeroId) {
      bytes.reserve(1)
      bytes.length += 1

      bytes.buffer[offset] = 0x00
    } else {
      bytes.reserve(9)
      bytes.length += 9

      bytes.buffer[offset] = 0xcf
      bytes.buffer[offset + 1] = id[0]
      bytes.buffer[offset + 2] = id[1]
      bytes.buffer[offset + 3] = id[2]
      bytes.buffer[offset + 4] = id[3]
      bytes.buffer[offset + 5] = id[4]
      bytes.buffer[offset + 6] = id[5]
      bytes.buffer[offset + 7] = id[6]
      bytes.buffer[offset + 8] = id[7]
    }
  }

  _encodeInteger (bytes, value) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    bytes.buffer[offset] = 0xce
    bytes.buffer[offset + 1] = value >> 24
    bytes.buffer[offset + 2] = value >> 16
    bytes.buffer[offset + 3] = value >> 8
    bytes.buffer[offset + 4] = value
  }

  _encodeShort (bytes, value) {
    const offset = bytes.length

    bytes.reserve(3)
    bytes.length += 3

    bytes.buffer[offset] = 0xcd
    bytes.buffer[offset + 1] = value >> 8
    bytes.buffer[offset + 2] = value
  }

  _encodeLong (bytes, value) {
    const offset = bytes.length
    const hi = (value / Math.pow(2, 32)) >> 0
    const lo = value >>> 0

    bytes.reserve(9)
    bytes.length += 9

    bytes.buffer[offset] = 0xcf
    bytes.buffer[offset + 1] = hi >> 24
    bytes.buffer[offset + 2] = hi >> 16
    bytes.buffer[offset + 3] = hi >> 8
    bytes.buffer[offset + 4] = hi
    bytes.buffer[offset + 5] = lo >> 24
    bytes.buffer[offset + 6] = lo >> 16
    bytes.buffer[offset + 7] = lo >> 8
    bytes.buffer[offset + 8] = lo
  }

  _encodeUnsigned (bytes, value) {
    const offset = bytes.length

    if (value <= 0x7f) {
      bytes.reserve(1)
      bytes.length += 1

      bytes.buffer[offset] = value
    } else if (value <= 0xff) {
      bytes.reserve(2)
      bytes.length += 2

      bytes.buffer[offset] = 0xcc
      bytes.buffer[offset + 1] = value
    } else if (value <= 0xffff) {
      bytes.reserve(3)
      bytes.length += 3

      bytes.buffer[offset] = 0xcd
      bytes.buffer[offset + 1] = value >> 8
      bytes.buffer[offset + 2] = value
    } else if (value <= 0xffffffff) {
      bytes.reserve(5)
      bytes.length += 5

      bytes.buffer[offset] = 0xce
      bytes.buffer[offset + 1] = value >> 24
      bytes.buffer[offset + 2] = value >> 16
      bytes.buffer[offset + 3] = value >> 8
      bytes.buffer[offset + 4] = value
    } else {
      const hi = (value / Math.pow(2, 32)) >> 0
      const lo = value >>> 0

      bytes.reserve(9)
      bytes.length += 9

      bytes.buffer[offset] = 0xcf
      bytes.buffer[offset + 1] = hi >> 24
      bytes.buffer[offset + 2] = hi >> 16
      bytes.buffer[offset + 3] = hi >> 8
      bytes.buffer[offset + 4] = hi
      bytes.buffer[offset + 5] = lo >> 24
      bytes.buffer[offset + 6] = lo >> 16
      bytes.buffer[offset + 7] = lo >> 8
      bytes.buffer[offset + 8] = lo
    }
  }

  _encodeMap (bytes, value) {
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => typeof value[key] === 'string' || typeof value[key] === 'number')

    this._encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      this._encodeString(bytes, key)
      this._encodeValue(bytes, value[key])
    }
  }

  _encodeValue (bytes, value) {
    switch (typeof value) {
      case 'string':
        this._encodeString(bytes, value)
        break
      case 'number':
        this._encodeFloat(bytes, value)
        break
      default:
        // should not happen
    }
  }

  _encodeFixString (bytes, value = '') {
    this._cacheString(value)
    this._encodeUnsigned(bytes, this._stringMap[value])
  }

  _encodeString (bytes, value = '') {
    this._cacheString(value)
    this._encodeUnsigned(bytes, this._stringMap[value])
  }

  _encodeFloat (bytes, value) {
    float64Array[0] = value

    const offset = bytes.length
    bytes.reserve(9)
    bytes.length += 9

    bytes.buffer[offset] = 0xcb

    if (bigEndian) {
      for (let i = 0; i <= 7; i++) {
        bytes.buffer[offset + i + 1] = uInt8Float64Array[i]
      }
    } else {
      for (let i = 7; i >= 0; i--) {
        bytes.buffer[bytes.length - i - 1] = uInt8Float64Array[i]
      }
    }
  }

  _cacheString (value) {
    if (!(value in this._stringMap)) {
      this._stringMap[value] = this._stringCount++
      this._stringBytes.write(value)
    }

    return this._stringMap[value]
  }

  _writeArrayPrefix (buffer, offset, count) {
    buffer[offset++] = 0xdd
    buffer.writeUInt32BE(count, offset)

    return offset + 4
  }

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }

  _writeEvents (buffer, offset = 0) {
    offset = this._writeArrayPrefix(buffer, offset, this._eventCount)
    offset += this._eventBytes.buffer.copy(buffer, offset, 0, this._eventBytes.length)

    return offset
  }
}

module.exports = { Encoder, encoder: new Encoder() }
