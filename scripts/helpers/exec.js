'use strict'

const execSync = require('child_process').execSync
const color = require('./color')

function exec (command, options) {
  options = { stdio: [0, 1, 2], ...options }

  execSync(`echo "${color.GRAY}$ ${command}${color.NONE}"`, { stdio: [0, 1, 2] })

  return execSync(command, options)
}

function pipe (command, options) {
  return exec(command, { stdio: 'pipe', ...options })
    .toString()
    .replace(/\n$/, '')
}

exec.pipe = pipe

module.exports = exec
