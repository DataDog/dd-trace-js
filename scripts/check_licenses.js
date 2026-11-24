/* eslint-disable no-console */
'use strict'

const { createReadStream } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')

const { name: rootPackageName } = require('../package.json')
const {
  listBunLockDependencies,
  readVendoredDependencyNames,
} = require('./third-party-dependencies')

const filePath = join(__dirname, '..', 'LICENSE-3rdparty.csv')
const deps = getProdDeps()
const licenses = new Set()
let isHeader = true

const lineReader = readline.createInterface({
  input: createReadStream(filePath),
})

lineReader.on('line', line => {
  if (isHeader) {
    isHeader = false
    return
  }

  const trimmed = line.trim()
  if (!trimmed) return // Skip empty lines
  const columns = line.split(',')
  const component = columns[0]

  // Strip quotes from the component name
  licenses.add(component.replaceAll(/^"|"$/g, ''))
})

lineReader.on('close', () => {
  if (!checkLicenses(deps)) {
    process.exit(1)
  }
})

function getProdDeps () {
  const deps = new Set([rootPackageName])

  for (const { name } of listBunLockDependencies(join(__dirname, '..', 'bun.lock'))) {
    deps.add(name)
  }
  for (const { name } of listBunLockDependencies(join(__dirname, '..', 'vendor', 'bun.lock'))) {
    deps.add(name)
  }
  for (const name of readVendoredDependencyNames(join(__dirname, '..', '.github', 'vendored-dependencies.csv'))) {
    deps.add(name)
  }

  return deps
}

function checkLicenses (typeDeps) {
  const missing = []
  const extraneous = []

  for (const dep of typeDeps) {
    if (!licenses.has(dep)) {
      missing.push(dep)
    }
  }

  for (const dep of licenses) {
    if (!typeDeps.has(dep)) {
      extraneous.push(dep)
    }
  }

  if (missing.length) {
    console.error(`Missing 3rd-party license for ${missing.join(', ')}.`)
  }

  if (extraneous.length) {
    console.error(`Extraneous 3rd-party license for ${extraneous.join(', ')}.`)
  }

  return missing.length === 0 && extraneous.length === 0
}
