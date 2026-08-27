'use strict'

const express = require('express')

const app = express()
app.use((_req, res) => res.json({ dependency: 'express' }))

module.exports = (req, res) => app(req, res)
