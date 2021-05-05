if (Number(process.env.SERVER_USE_TRACER)) {
  require('../../..').init()
}

const { port, reqs } = require('./common')

const testing = process.env.TESTING

const http = require('http')
let connectionsMade = 0

const server = http.createServer((req, res) => {
  res.end('Hello, World!')
  if (++connectionsMade === reqs && testing === 'server') {
    process.exit()
  }
})
server.listen(port)
