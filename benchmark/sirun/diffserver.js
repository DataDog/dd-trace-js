'use strict'

const express = require('express')
const diffRecent = require('./diff-recent')
const {
  getBuildNumsFromGithub,
  get,
  artifactsUrl,
  circleHeaders
} = require('./get-results')

const app = express()

async function getSummary (commitish) {
  const builds = await getBuildNumsFromGithub(commitish)
  const build = builds[Object.keys(builds).find(n => n.includes('sirun-all'))]
  let artifacts = await get(artifactsUrl(build), circleHeaders)
  artifacts = JSON.parse(artifacts)
  const artifact = artifacts.find(a => a.path.endsWith('summary.json'))

  return JSON.parse(await get(artifact.url, circleHeaders))
}

app.get('/', async (req, res) => {
  const { before, after } = req.query
  if (!before || !after) {
    res.end('Please use <code>before</code> and </after> querystring options to specify commit range.')
    return
  }
  const beforeSummary = await getSummary(before)
  const afterSummary = await getSummary(after)
  const { html } = diffRecent(beforeSummary, afterSummary)
  res.end(html)
})

app.listen(8000)
