if (Number(process.env.SERVER_USE_TRACER)) {
  require('../../..').init()
}

const http = require('http')
let connectionsMade = 0

if (process.env.SET_PID === 'server') {
  const fs = require('fs')
  fs.writeFileSync('server.pid', '' + process.pid)
}

const requestListener = function (request, response) {
  response.end('Hello, World!')
  if (++connectionsMade === 10000 && process.env.SET_PID !== 'server') {
    setImmediate(() => {
      process.exit()
    })
  }
}

const server = http.createServer(requestListener)
server.listen(9090)
