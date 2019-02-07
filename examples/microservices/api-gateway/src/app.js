'use strict'

const axios = require('axios')
const express = require('express')
const expressWinston = require('express-winston')
const logger = require('./logger')

const app = express()

app.use(expressWinston.logger({
  winstonInstance: logger
}))

app.get('/users', (req, res) => {
  axios.get('http://auth:8080/.well-known/jwks.json')
    .then(() => {
      return axios.post('http://user:8080/graphql', {
        query: `{ users { name age } }`
      }, {
        headers: { 'Content-Type': 'application/json' }
      })
    })
    .then(response => {
      res.status(200).send(response.data.data)
    })
    .catch(() => {
      res.status(502).send()
    })
})

app.use(expressWinston.errorLogger({
  winstonInstance: logger
}))

module.exports = app
