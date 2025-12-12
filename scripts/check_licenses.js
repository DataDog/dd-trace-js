/* eslint-disable no-console */
'use strict'

const { createReadStream, existsSync } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')
const { execSync } = require('node:child_process')
const { name: rootPackageName } = require('../package.json')

const filePath = join(__dirname, '..', 'LICENSE-3rdparty.csv')
const deps = getProdDeps()
const licenses = new Set()
let isHeader = true

const lineReader = readline.createInterface({
  input: createReadStream(filePath)
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
  // Add root package (dd-trace) to the set of dependencies manually as it is not included in the yarn list output.
  const deps = new Set([rootPackageName])

  addProdDeps(deps, process.cwd())
  addProdDeps(deps, join(process.cwd(), 'vendor'))

  // Add vendored dependencies
  addVendoredDeps(deps)

  return deps
}

function addProdDeps (deps, cwd) {
  // Use yarn to get full tree of production (non-dev) dependencies (format is ndjson)
  const stdout = execSync('yarn list --production --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd
  })

  for (const line of stdout.split('\n')) {
    if (!line) continue
    const parsed = JSON.parse(line)
    if (parsed.type === 'tree' && Array.isArray(parsed.data?.trees)) {
      collectFromTrees(parsed.data.trees, deps)
    }
  }
}

function collectFromTrees (trees, deps) {
  for (const node of trees) {
    if (typeof node?.name !== 'string') continue

    // Remove version from the package name (e.g. `@protobufjs/pool@1.1.0` -> `@protobufjs/pool`)
    deps.add(node.name.slice(0, node.name.lastIndexOf('@')))

    if (Array.isArray(node.children) && node.children.length) {
      collectFromTrees(node.children, deps)
    }
  }
}

function addVendoredDeps (deps) {
  const vendoredDepsPath = join(__dirname, '..', '.github', 'vendored-dependencies.csv')

  // If the vendored dependencies file doesn't exist, skip
  if (!existsSync(vendoredDepsPath)) {
    return
  }

  const fs = require('node:fs')
  const content = fs.readFileSync(vendoredDepsPath, 'utf8')

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue // Skip empty lines

    const columns = line.split(',')
    const component = columns[0]

    // Strip quotes from the component name and add to deps
    deps.add(component.replaceAll(/^"|"$/g, ''))
  }
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
