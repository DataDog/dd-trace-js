if (Number(process.env.SERVER_USE_TRACER)) {
  require('../../..').init()
}

const http = require('http')

const requestListener = function (request, response) {
  response.end('Hello, World!')
//   request.setTimeout(500, () => { server.close() })
//   server.setTimeout(1000, () => { server.close() })
}

const server = http.createServer(requestListener)
server.listen(9090)
