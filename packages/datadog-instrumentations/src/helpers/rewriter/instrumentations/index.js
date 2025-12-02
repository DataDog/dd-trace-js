'use strict'

const { readdirSync, readFileSync } = require('fs')
const { join } = require('path')

const instrumentations = []

const files = readdirSync(__dirname).filter(f => f.endsWith('.json'))

// load all JSON instrumentations
for (const file of files) {
  try {
    const content = JSON.parse(readFileSync(join(__dirname, file), 'utf8'))
    if (Array.isArray(content)) {
      instrumentations.push(...content)
    } else {
      instrumentations.push(content)
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Failed to load instrumentation config: ${file}`, e.message)
  }
}

module.exports = instrumentations
