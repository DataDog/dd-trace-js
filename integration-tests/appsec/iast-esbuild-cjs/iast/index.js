'use strict'

const { execSync } = require('child_process')
const express = require('express')

const router = express.Router()

router.get('/cmdi-vulnerable', (req, res) => {
  execSync('ls', { input: req.query.args })

  res.end()
})

module.exports = router
