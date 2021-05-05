if (Number(process.env.CLIENT_USE_TRACER)) {
  require('../../..').init()
}

const { port, reqs } = require('./common')

const testing = process.env.TESTING

const http = require('http')
let connectionsMade = 0

function request (url) {
  http.get(`${url}`, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      if (++connectionsMade === reqs && testing === 'client') {
        process.exit()
      }
      request(url)
    })
  }).on('error', () => {
    setTimeout(() => {
      request(url)
    }, 10)
  })
}

request(`http://localhost:${port}/`)
