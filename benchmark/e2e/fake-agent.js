'use strict'
const http = require('http')

http.createServer(async (req, res) => {
  res.statusCode = 200
  if (await streamLen(req) > 0) {
    res.write(JSON.stringify({ rate_by_service: { 'service:,env:': 1 } }))
  }
  res.end()
}).listen(8126, 'localhost', () => {
  if (process.send) { process.send({ ready: true }) }
})

async function streamLen (strm) {
  try {
    let len = 0
    for await (const buf of strm) {
      len += buf.length
    }

    return len
  } catch (e) {
    return 0
  }
}
