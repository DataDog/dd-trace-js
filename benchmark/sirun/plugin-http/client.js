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

let url = `http://localhost:${port}/`

if (Number(process.env.CLIENT_LONG_QUERYSTRING)) {
  url += '?' + 'token=secret&'.repeat(100) + 'a'.repeat(1500)
}

request(url)
