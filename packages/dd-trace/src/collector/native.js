'use strict'

// TODO: Use node:ffi when it lands.
// https://github.com/nodejs/node/pull/46905

const path = require('path')
const { getNativeFunction, getBufferPointer } = require('sbffi')
const libPath = path.normalize(
  path.join(__dirname, '../../../../../dd-trace-collector/target/debug/libffi.dylib')
)
const submit = getNativeFunction(libPath, 'submit', 'uint32_t', [
  'uint32_t', 'uint8_t *', 'uint32_t', 'uint8_t *'
])

module.exports = {
  submit (data, host) {
    const hostBuf = Buffer.from(host)
    const dataPtr = getBufferPointer(data)
    const hostPtr = getBufferPointer(hostBuf)

    submit(data.length, dataPtr, hostBuf.length, hostPtr)
  }
}
