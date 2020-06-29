'use strict'

require('dotenv').config()
require('../..').init({ enabled: false })

const express = require('express')

const app = express()

let usage

app.get('/hello', (req, res) => {
  res.status(200).send('Hello World!')
})

app.get('/usage', (req, res) => {
  const diff = process.cpuUsage(usage)

  usage = process.cpuUsage()

  res.status(200).send(diff)
})

app.listen(process.env.PORT || 8080, '127.0.0.1', () => {
  usage = process.cpuUsage()
})
