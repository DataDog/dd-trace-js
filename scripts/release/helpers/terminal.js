'use strict'

/* eslint-disable no-console */

const { execSync, spawnSync } = require('child_process')

// Helpers for colored output.
const log = (...msgs) => msgs.forEach(msg => console.log(msg))
const success = (...msgs) => msgs.forEach(msg => console.log(`\x1b[32m${msg}\x1b[0m`))
const error = (...msgs) => msgs.forEach(msg => console.log(`\x1b[31m${msg}\x1b[0m`))
const whisper = (...msgs) => msgs.forEach(msg => console.log(`\x1b[90m${msg}\x1b[0m`))

// Helpers for exiting with a message.
const exit = (...msgs) => log(...msgs) || process.exit(0)
const fatal = (...msgs) => error(...msgs) || process.exit(1)

// Output a command to the terminal and execute it.
function run (cmd) {
  whisper(`> ${cmd}`)

  const output = execSync(cmd, {}).toString()

  log(output)
}

// Ask a question in terminal and return the response.
function prompt (question) {
  process.stdout.write(`${question} `)

  const child = spawnSync('bash', ['-c', 'read answer && echo $answer'], {
    stdio: ['inherit']
  })

  return child.stdout.toString()
}

// Ask whether to continue and otherwise exit the process.
function checkpoint (question) {
  const answer = prompt(`${question} [Y/n]`)

  if (answer?.toLowerCase() !== 'y') {
    process.exit(0)
  }
}

// Run a command and capture its output to return it to the caller.
function capture (cmd) {
  return execSync(cmd, {}).toString()
}

module.exports = { capture, checkpoint, error, exit, fatal, log, success, run, whisper }
