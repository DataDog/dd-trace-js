'use strict'

const tracer = require('../../')
tracer.init()

const http = require('http')

http.createServer((req, res) => {
  const delay = Math.random() < 0.01 // 1%
    ? 61 * 1000 // over 1 minute
    : Math.random() * 1000 // random 0 - 1s

  setTimeout(() => {
    res.write('Hello World!')
    res.end()
  }, delay)
}).listen(8080)
