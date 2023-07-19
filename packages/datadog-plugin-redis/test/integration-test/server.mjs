import tracer from 'dd-trace'
import redis from 'redis'
import http from 'http'

tracer.init({ port: process.env.AGENT_PORT })

const client = redis.createClient()

const server = http.createServer(async (req, res) => {
  await client.connect()
  await client.get('foo')
  res.end('hello, world\n')
  await client.quit()
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
