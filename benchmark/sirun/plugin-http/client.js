'use strict'

if (Number(process.env.CLIENT_USE_TRACER)) {
  require('../../..').init()
}

const { port, reqs } = require('./common')

const http = require('http')
let connectionsMade = 0

function request (url) {
  http.get(`${url}`, (res) => {
    res.on('data', () => {})
    res.on('end', () => {
      if (++connectionsMade !== reqs) {
        request(url)
      }
    })
  }).on('error', () => {
    setTimeout(() => {
      request(url)
    }, 10)
  })
}

request(`http://localhost:${port}/?aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&token=secret&aaaaaaaaaaaa`)
