'use strict'

const fs = require('fs')
const { execSync } = require('child_process')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', '.circleci', 'config.yml')

const currentYml = fs.readFileSync(CONFIG_PATH)

const expected = execSync('node generate_circle_config', {
  cwd: __dirname
})

if (currentYml.compare(expected) !== 0) {
  process.exitCode = 1
  // eslint-disable-next-line no-console
  console.error(`

  \x1b[1m\x1b[33m.circleci/config.yml\x1b[0m has unexpected content.

  Please run \x1b[1m\x1b[33myarn ciconfig\x1b[0m and commit the changes.

  `)
}
