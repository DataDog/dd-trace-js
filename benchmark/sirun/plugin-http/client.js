if (Number(process.env.CLIENT_USE_TRACER)) {
  require('../../..').init()
}

if (process.env.SET_PID === 'client') {
  const fs = require('fs')
  fs.writeFileSync('client.pid', '' + process.pid)
}

const http = require('http')
let connectionsMade = 0

function request (url) {
  http.get(`${url}`, (res) => {
    res.on('end', () => {
      if (++connectionsMade === 10000 && process.env.SET_PID !== 'client') {
        process.exit()
      }
      request('http://localhost:9090/')
    })
  })
}

request('http://localhost:9090/')
