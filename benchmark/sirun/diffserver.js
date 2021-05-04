'use strict'

/* global BigInt */

const express = require('express')
const diffRecent = require('./diff-recent')
const {
  getBuildNumsFromGithub,
  get,
  artifactsUrl,
  circleHeaders,
  getResults
} = require('./get-results')

const app = express()

function isHex (h) {
  const a = BigInt('0x' + h)
  return a.toString(16) === h
}

function cleanName (commitish) {
  return isHex(commitish) ? commitish.substr(0, 8) : commitish
}

async function getSummary (commitish) {
  const builds = await getBuildNumsFromGithub(commitish)
  const build = builds[Object.keys(builds).find(n => n.includes('sirun-all'))]
  if (!build) {
    return getResults(commitish)
  }
  let artifacts = await get(artifactsUrl(build), circleHeaders)
  artifacts = JSON.parse(artifacts)
  const artifact = artifacts.find(a => a.path.endsWith('summary.json'))
  if (!artifact) {
    return getResults(commitish)
  }

  return JSON.parse(await get(artifact.url, circleHeaders))
}

app.get('/', async (req, res) => {
  const { before, after, beforeName, afterName } = req.query
  if (!before || !after) {
    res.end('Please use <code>before</code> and </after> querystring options to specify commit range.')
    return
  }
  const beforeSummary = await getSummary(before)
  const afterSummary = await getSummary(after)
  const { html } = diffRecent(
    beforeSummary,
    afterSummary,
    beforeName || cleanName(before),
    afterName || cleanName(after)
  )
  res.end(html)
})

app.listen(8000)
