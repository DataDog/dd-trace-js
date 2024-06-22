'use strict'

require('../../dd-trace')
  .init({ plugins: false, sampleRate: 0 })
  .use('express')

const test = require('tape')
const express = require('../../../versions/express').get()
const axios = require('axios')
const profile = require('../../dd-trace/test/profile')

test('express plugin should not leak', t => {
  const app = express()

  app.use((req, res) => {
    res.status(200).send()
  })

  const listener = app.listen(0, '127.0.0.1', () => {
    const port = listener.address().port

    profile(t, operation).then(() => listener.close())

    function operation (done) {
      axios.get(`http://localhost:${port}`).then(done)
    }
  })
})
