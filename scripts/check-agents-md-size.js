#!/usr/bin/env node

'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const MAX_LINES = 200
const agentsPath = join(process.cwd(), 'AGENTS.md')
const content = readFileSync(agentsPath, 'utf8')
const lines = content === '' ? [] : content.split(/\r\n|\r|\n/)

if (lines.at(-1) === '') lines.pop()

if (lines.length > MAX_LINES) {
  // eslint-disable-next-line no-console
  console.error(
    `AGENTS.md has ${lines.length} lines. ` +
    `Keep AGENTS.md at ${MAX_LINES} lines or fewer. ` +
    'Check whether the added content can become a skill of its own.'
  )
  process.exitCode = 1
}
