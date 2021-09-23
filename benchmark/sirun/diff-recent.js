'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const walk = require('./results-diff')
const {
  getBuildNumsFromGithub,
  get,
  artifactsUrl,
  circleHeaders
} = require('./get-results')
const goalSummary = require('./goal.json')

function getReadmes () {
  const readmes = {}
  const dir = fs.readdirSync(__dirname, { withFileTypes: true })
  for (const dirent of dir) {
    if (dirent.isDirectory()) {
      try {
        const name = require(path.join(__dirname, dirent.name, 'meta.json')).name
        const value = fs.readFileSync(path.join(__dirname, dirent.name, 'README.md'), 'utf8')
        readmes[name] = value
      } catch (e) {
        // just keep going
      }
    }
  }
  return readmes
}

function diff (beforeSummary, afterSummary, prev = 'master', curr = 'this commit') {
  const diffTree = walk(afterSummary, beforeSummary)
  const html = fs.readFileSync(path.join(__dirname, 'diff.html'), 'utf8')
    .replace('REPLACE_ME_DIFF_DATA', JSON.stringify(diffTree, null, 2))
    .replace('REPLACE_ME_PREV_DATA', JSON.stringify(beforeSummary, null, 2))
    .replace('REPLACE_ME_CURR_DATA', JSON.stringify(afterSummary, null, 2))
    .replace('REPLACE_ME_GOAL_DATA', JSON.stringify(goalSummary, null, 2))
    .replace('REPLACE_ME_READMES', JSON.stringify(getReadmes(), null, 2))
    .replace(/REPLACE_ME_PREV/g, prev)
    .replace(/REPLACE_ME_CURR/g, curr)
  return { diffTree, html }
}

function latestVersionResults (jsonStr) {
  let json = JSON.parse(jsonStr)
  if (json.byVersion) {
    // TODO we want to eventually include all of them, but for now, we can just take the latest one
    // so that it's compatible with previous commits
    delete json.byVersion
    json = json[Object.keys(json).sort((a, b) => Number(b) - Number(a))[0]]
  }
  return json
}

const main = async () => {
  const prev = execSync('git rev-parse master').toString().trim()
  const builds = await getBuildNumsFromGithub(prev)
  const buildId = Object.keys(builds).find(n => n.includes('sirun-all'))
  if (!buildId) {
    console.error('No `sirun-all` build found on master.')
    return
  }
  const build = builds[buildId]

  const artifacts = JSON.parse(await get(artifactsUrl(build), circleHeaders))
  const artifact = artifacts.find(a => a.path.endsWith('summary.json'))
  if (!artifact) {
    console.error('summary.json artifact not found on master')
    console.error('artifacts', JSON.stringify(artifacts, null, 2))
    return
  }
  const prevSummary = latestVersionResults(await get(artifact.url, circleHeaders))
  const currentSummary = latestVersionResults(fs.readFileSync('/tmp/artifacts/summary.json'))

  const thisCommit = execSync('git rev-parse HEAD').toString().trim()
  const { diffTree, html } = diff(prevSummary, currentSummary, 'master', thisCommit)

  console.log(JSON.stringify(diffTree, null, 2))

  fs.writeFileSync('/tmp/artifacts/diff.html', html)
}

module.exports = diff

if (require.main === module) {
  main()
}
