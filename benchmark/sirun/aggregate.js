'use strict'

const fs = require('fs')
const path = require('path')
const { summarizeResults } = require('./get-results')

const jsons = []
const ndjsons = fs.readdirSync(__dirname)
  .filter(n => n.endsWith('.ndjson'))

const versionResults = {}
ndjsons.forEach(n => {
  const filename = path.join(__dirname, n.toString())
  const lines = fs.readFileSync(filename, 'utf8').trim().split('\n')

  lines.forEach(json => {
    try {
      const results = JSON.parse(json)
      const nodeVersion = results.nodeVersion.split('.')[0]
      if (!versionResults[nodeVersion]) {
        versionResults[nodeVersion] = []
      }
      versionResults[nodeVersion].push(results)
      jsons.push(json)
    } catch (e) {
      console.error(`Could not parse ${filename}.`) // eslint-disable-line no-console
      throw e
    }
  })
})

fs.writeFileSync('all-sirun-output.ndjson', jsons.join('\n'))

const buildData = {
  byVersion: true
}
for (const version in versionResults) {
  buildData[version] = {}
  summarizeResults(buildData[version], versionResults[version])
}

// eslint-disable-next-line no-console
console.log(JSON.stringify(buildData, null, 2))
