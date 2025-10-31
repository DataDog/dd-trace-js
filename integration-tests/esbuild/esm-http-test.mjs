import './init.mjs'

import http from 'http'

process.env.DD_TRACE_DEBUG = 'true'

const server = http.createServer((req, res) => {
  res.end('Egun on!')
})

server.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
