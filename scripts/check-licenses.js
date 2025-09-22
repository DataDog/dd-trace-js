'use strict'

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const pkg = require(path.join(__dirname, '..', '/package.json'))

const filePath = path.join(__dirname, '..', '/LICENSE-3rdparty.csv')
const deps = new Set(Object.keys(pkg.dependencies || {}))
const devDeps = new Set(Object.keys(pkg.devDependencies || {}))

let index = 0

const licenses = {
  require: new Set(),
  dev: new Set(),
  file: new Set()
}

const lineReader = readline.createInterface({
  input: fs.createReadStream(filePath)
})

lineReader.on('line', line => {
  if (index !== 0) {
    const columns = line.split(',')
    const type = columns[0]
    const license = columns[1]

    licenses[type].add(license)
  }

  index++
})

lineReader.on('close', () => {
  if (!checkLicenses(deps, 'require') || !checkLicenses(devDeps, 'dev')) {
    process.exit(1)
  }
})

function checkLicenses (typeDeps, type) {
  /* eslint-disable no-console */

  const missing = []
  const extraneous = []

  for (const dep of typeDeps) {
    if (!licenses[type].has(dep)) {
      missing.push(dep)
    }
  }

  for (const dep of licenses[type]) {
    if (!typeDeps.has(dep)) {
      extraneous.push(dep)
    }
  }

  if (missing.length) {
    console.log(`Missing 3rd-party license for ${missing.join(', ')}.`)
  }

  if (extraneous.length) {
    console.log(`Extraneous 3rd-party license for ${extraneous.join(', ')}.`)
  }

  return missing.length === 0 && extraneous.length === 0
}
