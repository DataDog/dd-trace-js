'use strict'

const express = require('express')
const { execSync } = require('child_process')

const router = express.Router()

router.get('/cmdi-vulnerable', (req, res) => {
  execSync(`ls ${req.query.args}`)

  res.end()
})

module.exports = router
