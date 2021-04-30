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

function diff (beforeSummary, afterSummary) {
  const diffTree = walk(afterSummary, beforeSummary)
  const html = fs.readFileSync(path.join(__dirname, 'diff.html'), 'utf8')
    .replace('REPLACE_ME_DIFF_DATA', JSON.stringify(diffTree, null, 2))
    .replace('REPLACE_ME_READMES', JSON.stringify(getReadmes(), null, 2))
  return { diffTree, html }
}

const main = async () => {
  const prev = execSync('git rev-parse HEAD^').toString().trim()
  const builds = await getBuildNumsFromGithub(prev)
  const build = builds[Object.keys(builds).find(n => n.includes('sirun-all'))]

  const artifacts = JSON.parse(await get(artifactsUrl(build), circleHeaders))
  const artifact = artifacts.find(a => a.path.endsWith('summary.json'))
  if (!artifact) {
    console.error('summary.json artifact not found')
    console.error('artifacts', JSON.stringify(artifacts, null, 2))
    return
  }
  const prevSummary = JSON.parse(await get(artifact.url, circleHeaders))
  const currentSummary = JSON.parse(fs.readFileSync('/tmp/artifacts/summary.json'))

  const { diffTree, html } = diff(prevSummary, currentSummary)

  console.log(JSON.stringify(diffTree, null, 2))

  fs.writeFileSync('/tmp/artifacts/diff.html', html)
}

module.exports = diff

if (require.main === 'module') {
  main()
}
