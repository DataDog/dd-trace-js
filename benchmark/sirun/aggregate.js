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

const buildData = {}
const testResults = ndjsons
  .trim().split('\n').map(x => JSON.parse(x))
summarizeResults(buildData, testResults)

// eslint-disable-next-line no-console
console.log(JSON.stringify(buildData, null, 2))
