'use strict'

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

(async () => {
  const prev = execSync('git rev-parse HEAD^').toString().trim()
  const builds = await getBuildNumsFromGithub(prev)
  const build = builds[Object.keys(builds).find(n => n.includes('sirun-all'))]

  let artifacts = await get(artifactsUrl(build), circleHeaders)
  console.log(artifacts)
  artifacts = JSON.parse(artifacts)
  const artifact = artifacts.find(a => a.path.endsWith('summary.json'))
  if (!artifact) return
  const prevSummary = JSON.parse(await get(artifact.url, circleHeaders))
  const currentSummary = JSON.parse(fs.readFileSync('/tmp/artifacts/summary.json'))

  const diffTree = walk(currentSummary, prevSummary)

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(diffTree, null, 2))

  const html = fs.readFileSync(path.join(__dirname, 'diff.html'), 'utf8')
  fs.writeFileSync(
    '/tmp/artifacts/diff.html',
    html.replace('REPLACE_ME_DIFF_DATA', JSON.stringify(diffTree, null, 2))
      .replace('REPLACE_ME_READMES', JSON.stringify(getReadmes(), null, 2))
  )
})()
