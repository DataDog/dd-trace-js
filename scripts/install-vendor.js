'use strict'

const { execSync } = require('node:child_process')

const { bun } = require('../package.json').devDependencies

execSync(`npm exec --yes --package=bun@${bun} -- bun install --cwd vendor ` +
  '--config=../bunfig.toml --silent --frozen-lockfile', { stdio: 'inherit' })
