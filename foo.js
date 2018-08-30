const msgpack = require('msgpack-lite')
const traceStub = require('./benchmark/stubs/trace')

let str = 'abcdefgh'
const buffer = Buffer.alloc(8 * 1024 * 1024)

for (let i = 0; i < 8; i++) {
  str = str + str
}

console.log(str.length)

console.time('bench')

const src = Buffer.alloc(8)
src.write(str)

for (let i = 0; i < 1000000; i++) {
  write(buffer, str)
  // Buffer.alloc(8)
  // Buffer.byteLength(str)
  // buffer.write(str)
  // src.copy(buffer)
  // buffer[0] = buffer[buffer.length - 1]
  // buffer[1] = str.charCodeAt(1)
  // buffer[2] = str.charCodeAt(2)
  // buffer[3] = str.charCodeAt(3)
  // buffer[4] = str.charCodeAt(4)
  // buffer[5] = str.charCodeAt(5)
  // buffer[6] = str.charCodeAt(6)
  // buffer[7] = str.charCodeAt(7)
  // const stream = msgpack.createEncodeStream()
  // stream.write(traceStub)
  // stream.end()
  // msgpack.encode(traceStub)
}

function write (buffer, str) {
  const len = str.length
  for (let i = 0; i < len; i++) {
    buffer[i] = str.charCodeAt(i)
  }
}

console.timeEnd('bench')
