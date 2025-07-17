'use strict'

/* eslint-disable no-console */

const chunks = []
process.stdin.on('data', (data) => {
  chunks.push(data)
})
process.stdin.on('end', () => {
  const data = Buffer.concat(chunks).toString()
  const json = JSON.parse(data)
  for (const testSuite in json) {
    console.log('Test Suite: ', testSuite)
    const variants = Object.keys(json[testSuite])
    const results = {}
    for (const variant of variants) {
      const { summary } = json[testSuite][variant]
      results[variant] = {
        wallTime: summary['wall.time'].mean,
        userTime: summary['user.time'].mean,
        sysTime: summary['system.time'].mean,
        maxResSize: summary['max.res.size'].mean
      }
    }
    const newResults = []
    Object.keys(results).sort().forEach((name) => {
      newResults.push({ name, ...results[name] })
    })
    console.table(newResults)
  }
})
