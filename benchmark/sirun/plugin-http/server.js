if (Number(process.env.SERVER_USE_TRACER)) {
  require('../../..').init()
}

const testing = process.env.TESTING

const http = require('http')
let connectionsMade = 0

if (testing !== 'server') {
  const fs = require('fs')
  fs.writeFileSync('server.pid', '' + process.pid)
}

const server = http.createServer((req, res) => {
  res.end('Hello, World!')
  if (++connectionsMade === 10000 && testing === 'server') {
    setImmediate(() => {
      process.exit()
    })
  }
})
server.listen(process.env.PORT)
