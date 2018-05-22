'use strict'

const exec = require('child_process').execSync
const color = require('./color')

function title (str) {
  const options = { stdio: [0, 1, 2] }
  const line = ''.padStart(str.length, '=')

  exec(`echo "${color.CYAN}${line}${color.NONE}"`, options)
  exec(`echo "${color.CYAN}${str}${color.NONE}"`, options)
  exec(`echo "${color.CYAN}${line}${color.NONE}"`, options)
}

module.exports = title
