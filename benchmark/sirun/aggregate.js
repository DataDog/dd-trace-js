'use strict'

const fs = require('fs')
const path = require('path')

const ndjsons = fs.readdirSync(__dirname)
  .map(n =>
    n.endsWith('.ndjson') ?
      fs.readFileSync(path.join(__dirname, n.toString()), 'utf8').trim() :
      ''
  )
  .join('\n')

fs.writeFileSync('all-sirun-output.ndjson', ndjsons)

function mean (items) {
  const len = items.length
  const total = items.reduce((prev, cur) => prev + cur, 0)
  return total / len
}

function stddev (m, items) {
  return Math.sqrt(mean(items.map(x => (x - m) ** 2)))
}

function summary (iterations) {
  const stats = {}
  for (const iteration of iterations) {
    for (const [k, v] of Object.entries(iteration)) {
      if (!stats[k]) {
        stats[k] = []
      }
      stats[k].push(v)
    }
  }
  const result = {}
  for (const [name, items] of Object.entries(stats)) {
    const m = mean(items)
    const s = stddev(m, items)
    result[name] = {
      mean: m,
      stddev: s,
      stddev_pct: (s / m) * 100.0,
      min: Math.min(...items),
      max: Math.max(...items)
    }
  }
  return result
}

const buildData = {}
const testResults = ndjsons
  .trim().split('\n').map(x => JSON.parse(x))
for (const result of testResults) {
  const name = result.name
  const variant = result.variant
  if (!buildData[name]) {
    buildData[name] = {}
  }
  delete result.name
  delete result.variant
  if (result.iterations) {
    result.summary = summary(result.iterations)
  }
  delete result.iterations
  buildData[name][variant] = result
}

console.log(JSON.stringify(buildData, null, 2))
