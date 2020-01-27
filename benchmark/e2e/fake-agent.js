'use strict'
const fs = require('fs')
const http = require('http')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

const output = fs.createWriteStream(`./spans.nsjson`)

const agent = http.createServer((req, res) => {
  concatStream(req, body => {
    if (body.length === 0) return res.status(200).send()
    body = msgpack.decode(body, { codec })
    body.forEach(trace => {
      trace.forEach(span => {
        output.write(JSON.stringify(span) + '\n')
      })
    })
    res.statusCode = 200
    res.end(JSON.stringify({ rate_by_service: { 'service:,env:': 1 } }))
  })
})

agent.listen(8126, () => {
  process.send({ ready: true })
})
agent.on('close', () => output.close())

function concatStream (strm, cb) {
  const bufs = []
  strm
    .on('data', data => bufs.push(data))
    .on('end', () => cb(Buffer.concat(bufs)))
}
