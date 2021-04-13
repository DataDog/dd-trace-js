if (Number(process.env.CLIENT_USE_TRACER)) {
  require('../../..').init()
}

const http = require('http')
const count = process.env.COUNT ? Number(process.env.COUNT) : 5000

function request (url) {
  for (let i = 0; i < count; i++) {
    http.get(`${url}`)
  }
}

request('http://localhost:9090/')
