'use strict'

const express = require('express')
const crypto = require('crypto')

const app = express()

app.get('/one-vulnerability', (req, res) => {
  crypto.createHash('sha1').update('abccc').digest('hex')

  res.end('OK')
})

app.get('/five-vulnerabilities', (req, res) => {
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')

  res.end('OK')
})

app.post('/five-vulnerabilities', (req, res) => {
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')

  res.end('OK')
})

app.use('/route1', (req, res, next) => {
  Math.random()
  Math.random()

  next()
})

app.get('/route1/sub1', (req, res) => {
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')

  res.end('OK')
})

app.get('/route1/sub2', (req, res) => {
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')

  res.end('OK')
})

app.get('/route2/:param', (req, res) => {
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')
  crypto.createHash('sha1').update('test').digest('hex')

  res.end('OK')
})

const server = app.listen(process.env.APP_PORT || 0, () => {
  process.send?.({ port: server.address().port })
})
