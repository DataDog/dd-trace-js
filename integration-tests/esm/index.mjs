import tracer from '../../index.js'
import http from 'http'

const options = {}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

tracer.init(options)

const server = http.createServer((req, res) => {
  res.end('hello, world\n')
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
