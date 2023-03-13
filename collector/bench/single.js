const http = require('http')
const id = require('../../packages/dd-trace/src/id')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

const traceId = id()
const spanId = id()
const startTime = id((Date.now() * 1e6).toString(), 10)
const finishTime = id(((Date.now() + 100) * 1e6).toString(), 10)

const payload = msgpack.encode({
  'events': [
    [1, startTime, traceId, spanId, 0, 'GET', '/some/path'],
    [3, finishTime, traceId, spanId, 200]
  ]
}, { codec })

const req = http.request({
  method: 'put',
  port: 8127,
  path: '/v0.1/events'
}, res => {
  let data = ''

  res.on('data', chunk => {
    data += chunk
  })

  res.on('end', () => {
    console.log(`Response: ${data}`) // eslint-disable-line no-console
  })
})

req.setHeader('Content-Type', 'application/msgpack')
req.write(payload)

req.end()
