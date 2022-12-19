#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const IGNORE_TESTS = new Set([
  'profiler'
])

const IGNORE_STATS = [
  'system.time'
]

const lines = fs
  .readFileSync(path.join(__dirname, 'results.ndjson'))
  .toString()
  .trim()
  .split('\n')

const results = []

for (const line of lines) {
  const obj = JSON.parse(line)

  if (IGNORE_TESTS.has(obj.name)) {
    continue
  }

  for (const iteration of obj.iterations) {
    for (const stat of IGNORE_STATS) {
      if (stat in iteration) {
        delete iteration[stat]
      }
    }
  }
  results.push(JSON.stringify(obj))
}

fs.writeFileSync('./results.ndjson', results.join('\n'))
