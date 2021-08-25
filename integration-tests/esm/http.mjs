import tracer from '../../index.js'
import http from 'http'

tracer.init({ port: process.env.AGENT_PORT })

const server = http.createServer((req, res) => {
  res.end('hello, world\n')
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
