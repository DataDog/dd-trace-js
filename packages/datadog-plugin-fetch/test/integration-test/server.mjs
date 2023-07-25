import 'dd-trace/init.js'
import http from 'http'
import express from 'express'

const app = express()

app.get('/user', (req, res) => {
  res.status(200).send()
})
const server = http.createServer(app)

server.listen(0, 'localhost', () => {
  const port = server.address().port
  global.fetch(`http://localhost:${port}/user`)
  process.send({ port })
})
