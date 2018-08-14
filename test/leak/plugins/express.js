'use strict'

require('../../..')
  .init({ plugins: false, sampleRate: 0 })
  .use('express')

const test = require('tape')
const express = require('express')
const axios = require('axios')
const getPort = require('get-port')
const profile = require('../../profile')

test('express plugin should not leak', t => {
  getPort().then(port => {
    const app = express()

    app.use((req, res) => {
      res.status(200).send()
    })

    const listener = app.listen(port, '127.0.0.1', () => {
      profile(t, operation).then(() => listener.close())

      function operation (done) {
        axios.get(`http://localhost:${port}`).then(done)
      }
    })
  })
})
