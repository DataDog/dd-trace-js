'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const pkg = require(path.join(__dirname, '..', '/package.json'))

const filePath = path.join(__dirname, '..', '/LICENSE-3rdparty.csv')
const deps = Object.keys(pkg.dependencies || {})
  .concat(Object.keys(pkg.devDependencies || {}))
  .concat(Object.keys(pkg.optionalDependencies || {}))
  .sort()

let index = 0
const licenses = []

const lineReader = readline.createInterface({
  input: fs.createReadStream(filePath)
})

lineReader.on('line', line => {
  if (index !== 0) {
    const license = line.split(',')[1]
    licenses.push(license)
  }

  index++
})

lineReader.on('close', () => {
  /* eslint-disable no-console */

  if (JSON.stringify(deps) !== JSON.stringify(licenses.sort())) {
    console.log('Dependencies:')
    console.log(deps.join(','))
    console.log()
    console.log('Licenses:')
    console.log(licenses.join(','))
    console.log()

    throw new Error(`Dependencies and 3rd party licenses mismatch`)
  }
})
