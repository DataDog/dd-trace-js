'use strict'

const fs = require('fs')
const path = require('path')
const { summarizeResults } = require('./get-results')

const ndjsons = fs.readdirSync(__dirname)
  .map(n =>
    n.endsWith('.ndjson')
      ? fs.readFileSync(path.join(__dirname, n.toString()), 'utf8').trim()
      : ''
  )
  .join('\n')

fs.writeFileSync('all-sirun-output.ndjson', ndjsons)

const versionResults = {}
ndjsons.trim().split('\n').forEach(x => {
  try {
    const results = JSON.parse(x)
    const nodeVersion = results.nodeVersion.split('.')[0]
    if (!versionResults[nodeVersion]) {
      versionResults[nodeVersion] = []
    }
    versionResults[nodeVersion].push(results)
  } catch (e) {
    console.log(x) // eslint-disable-line no-console
    throw e
  }
})

const buildData = {
  byVersion: true
}
for (const version in versionResults) {
  buildData[version] = {}
  summarizeResults(buildData[version], versionResults[version])
}

// eslint-disable-next-line no-console
console.log(JSON.stringify(buildData, null, 2))
