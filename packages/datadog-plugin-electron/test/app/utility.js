'use strict'

require('../tracer')

const { net } = require('electron')

process.parentPort.on('message', ({ data }) => {
  if (data.name !== 'request') return
  const req = net.request(data.url)
  req.on('response', res => {
    res.on('data', () => {})
    res.on('end', () => {})
  })
  req.on('error', () => {})
  req.end()
})
