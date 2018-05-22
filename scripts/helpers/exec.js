'use strict'

const execSync = require('child_process').execSync
const color = require('./color')

function exec (command, options) {
  options = Object.assign({ stdio: [0, 1, 2] }, options)

  execSync(`echo "${color.GRAY}$ ${command}${color.NONE}"`, options)
  execSync(command, options)
}

module.exports = exec
