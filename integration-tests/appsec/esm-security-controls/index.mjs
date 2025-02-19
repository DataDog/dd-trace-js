'use strict'

import childProcess from 'node:child_process'
import express from 'express'
import { sanitize } from './sanitizer.mjs'
import sanitizeDefault from './sanitizer-default.mjs'
import { validate, validateNotConfigured } from './validator.mjs'

const app = express()
const port = process.env.APP_PORT || 3000

app.get('/cmdi-s-secure', (req, res) => {
  const command = sanitize(req.query.command)
  try {
    childProcess.execSync(command)
  } catch (e) {
    // ignore
  }

  res.end()
})

app.get('/cmdi-s-secure-comparison', (req, res) => {
  const command = sanitize(req.query.command)
  try {
    childProcess.execSync(command)
  } catch (e) {
    // ignore
  }

  try {
    childProcess.execSync(req.query.command)
  } catch (e) {
    // ignore
  }

  res.end()
})

app.get('/cmdi-s-secure-default', (req, res) => {
  const command = sanitizeDefault(req.query.command)
  try {
    childProcess.execSync(command)
  } catch (e) {
    // ignore
  }

  res.end()
})

app.get('/cmdi-iv-insecure', (req, res) => {
  if (validateNotConfigured(req.query.command)) {
    childProcess.execSync(req.query.command)
  }

  res.end()
})

app.get('/cmdi-iv-secure', (req, res) => {
  if (validate(req.query.command)) {
    childProcess.execSync(req.query.command)
  }

  res.end()
})

app.listen(port, () => {
  process.send({ port })
})
