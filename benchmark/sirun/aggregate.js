'use strict'

const fs = require('fs')
const path = require('path')
const { summarizeResults } = require('./get-results')

const ndjsons = fs.readdirSync(__dirname)
  .filter(n => n.endsWith('.ndjson'))

fs.writeFileSync('all-sirun-output.ndjson', ndjsons)

const versionResults = {}
ndjsons.forEach(n => {
  const filename = path.join(__dirname, n.toString())
  const contents = fs.readFileSync(filename, 'utf8').trim()

  try {
    const results = JSON.parse(contents)
    const nodeVersion = results.nodeVersion.split('.')[0]
    if (!versionResults[nodeVersion]) {
      versionResults[nodeVersion] = []
    }
    versionResults[nodeVersion].push(results)
  } catch (e) {
    console.error(`Could not parse ${filename}.`) // eslint-disable-line no-console
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
