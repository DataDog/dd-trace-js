import tracer from 'dd-trace'
import pg from 'pg'
import http from 'http'

tracer.init({ port: process.env.AGENT_PORT })

const conn = {
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'postgres',
  port: 5432
}

const client = new pg.Client(conn)
client.connect()

const server = http.createServer(async (req, res) => {
  await client.query('SELECT NOW() AS now')
  client.end()
  res.end('hello, world\n')
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
