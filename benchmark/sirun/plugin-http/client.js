if (Number(process.env.CLIENT_USE_TRACER)) {
  require('../../..').init()
}

const testing = process.env.TESTING

if (testing !== 'client') {
  const fs = require('fs')
  fs.writeFileSync('client.pid', '' + process.pid)
}

const http = require('http')
let connectionsMade = 0

function request (url) {
  http.get(`${url}`, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      if (++connectionsMade === 100000 && testing === 'client') {
        process.exit()
      }
      request(url)
    })
  }).on('error', () => {
    setTimeout(() => {
      request(url)
    }, 1000)
  })
}

request(`http://localhost:${process.env.PORT}/`)
