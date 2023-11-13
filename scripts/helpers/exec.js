'use strict'

const execSync = require('child_process').execSync
const color = require('./color')

function exec (command, options) {
  options = Object.assign({ stdio: [0, 1, 2] }, options)

  execSync(`echo "${color.GRAY}$ ${command}${color.NONE}"`, { stdio: [0, 1, 2] })

  console.log(199, command, options)

  // return execSync(command, options)
  let res = null

  try {
    res = execSync(command, options)
  } catch (e) {
    console.log(e)
  }

  return res
}

function pipe (command, options) {
  console.log(10000, command)
  return exec(command, Object.assign({ stdio: 'pipe' }, options))
    .toString()
    .replace(/\n$/, '')
}

exec.pipe = pipe

module.exports = exec
