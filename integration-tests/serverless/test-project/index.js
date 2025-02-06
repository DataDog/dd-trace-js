'use strict'

const functions = require('@google-cloud/functions-framework')

functions.http('helloGET', (req, res) => {
  res.send('Hello World!')
})
