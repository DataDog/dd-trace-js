const buffer = Buffer.alloc(8 * 1024)

const str = 'efljnwelfn wefn wekf nweklfu bweklf bweklf bwelf bwef b efljnwelfn wefn wekf nweklfu bweklf bweklf bwelf bwef b efljnwelfn wefn wekf nweklfu bweklf bweklf bwelf bwef b'
let strbuf
const buf = Buffer.from(str)

console.time('buffer')

for (let i = 0; i < 10000000; i++) {
  // buffer.writeUInt8(12)
  // buffer.write(str)
  buf.copy(buffer)
}

console.timeEnd('buffer')

console.time('str')

for (let i = 0; i < 10000000; i++) {
  strbuf = str + str
}

console.timeEnd('str')
