'use strict'

const express = require('express')
const cache = require('./cache')
const expressWinston = require('express-winston')
const logger = require('./logger')

const app = express()

app.use(expressWinston.logger({
  winstonInstance: logger
}))

app.get('/.well-known/jwks.json', (req, res) => {
  cache.get('jwks', (err, value) => {
    if (err) {
      return res.status(500).send()
    }

    res.status(200).send(value)
  })
})

app.use(expressWinston.errorLogger({
  winstonInstance: logger
}))

module.exports = app
