const SpanLink = require('./packages/dd-trace/src/opentelemetry/span_link.js')
const linkData = {
  traceId: '1234567890',
  spanId: '9876543210'
}
const link = new SpanLink(linkData)
link.addAttribute('link.name', 'Job #578')
link.addAttribute('foo', 'bar')
link.addAttribute('hey', false)
console.log(link.encode())
console.log(link.length)
console.log(Buffer.byteLength(link.encode()))
link.addAttribute('boo', [123, [true, false], ['hi', ['bye']]])
// console.log(link._attributesEncoded)
// link.addAttribute('bad', Buffer.alloc(10))
// console.log(link._encoded)
// link.addAttribute('bad', Buffer.alloc(10))
// console.log(link._encoded)
// for (let i = 0; i < 10; i++) {
//   link.addAttribute(`bad${i}`, Buffer.alloc(10))
// }
link.addAttribute('bad', Buffer.alloc(10))
console.log(link.encode())
console.log(link.length)
console.log(Buffer.byteLength(link.encode()))
link.flushAttributes()
console.log(link.encode())
console.log(link.length)
console.log(Buffer.byteLength(link.encode()))
