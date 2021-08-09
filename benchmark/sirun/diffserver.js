'use strict'

/* global BigInt */

const express = require('express')
const path = require('path')
const fs = require('fs')
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

let metas

function getMetas () {
  if (metas) return metas

  metas = {}
  const dir = fs.readdirSync(__dirname, { withFileTypes: true })
  for (const dirent of dir) {
    if (dirent.isDirectory()) {
      try {
        const meta = require(path.join(__dirname, dirent.name, 'meta.json'))
        metas[meta.name] = meta
      } catch (e) {
        // just keep going
      }
    }
  }
  return metas
}

function subtractBaselines (summary) {
  const metas = getMetas()
  for (const [name, variants] of Object.entries(summary)) {
    const baselines = []
    for (const [variant, metrics] of Object.entries(variants)) {
      if (
        metas[name] &&
        metas[name].variants &&
        metas[name].variants[variant] &&
        metas[name].variants[variant].baseline
      ) {
        const { baseline } = metas[name].variants[variant]
        const baselineMetrics = variants[baseline]
        variants[`${variant}-over-${baseline}`] = {
          instructions: metrics.instructions - baselineMetrics.instructions,
          nodeVersion: metrics.nodeVersion,
          summary: Object.keys(metrics.summary).reduce((acc, metric) => {
            acc[metric] = {
              mean: metrics.summary[metric].mean - baselineMetrics.summary[metric].mean
            }
            return acc
          }, {})
        }
        delete variants[variant]
        baselines.push(baseline)
      }
    }
    for (const variant of baselines) {
      delete variants[variant]
    }
  }
  return summary
}

const summaryCache = {}

async function getSummary (commitish) {
  const cached = summaryCache[commitish]
  if (cached) {
    return cached
  }
  const builds = await getBuildNumsFromGithub(commitish)
  const build = builds[Object.keys(builds).find(n => n.includes('sirun-all'))]
  if (!build) {
    const result = subtractBaselines(getResults(commitish))
    summaryCache[commitish] = result
    return result
  }
  let artifacts = await get(artifactsUrl(build), circleHeaders)
  artifacts = JSON.parse(artifacts)
  const artifact = artifacts.find(a => a.path.endsWith('summary.json'))

  // This only happens for older commits.
  if (!artifact) {
    const result = subtractBaselines(getResults(commitish))
    summaryCache[commitish] = result
    return result
  }

  let json = JSON.parse(await get(artifact.url, circleHeaders))
  if (json.byVersion) {
    // TODO we want to eventually include all of them, but for now, we can just take the latest one
    // so that it's compatible with previous commits
    delete json.byVersion
    json = json[Object.keys(json).sort((a, b) => Number(b) - Number(a))[0]]
  }
  const result = subtractBaselines(json)
  summaryCache[commitish] = result
  return result
}

app.get('/', async (req, res) => {
  const { before, after, beforeName, afterName } = req.query
  if (!before || !after) {
    res.end('Please use <code>before</code> and <code>after</code> querystring options to specify commit range.')
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
