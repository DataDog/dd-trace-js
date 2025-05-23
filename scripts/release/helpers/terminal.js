'use strict'

const { spawnSync } = require('child_process')

const { params, flags } = parse()

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const ERASE = '\x1b[0K'
const GRAY = '\x1b[90m'
const GREEN = '\x1b[32m'
const PREVIOUS = '\x1b[1A'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

const print = (...msgs) => msgs.forEach(msg => process.stdout.write(msg))
const log = (...msgs) => msgs.forEach(msg => print(`${msg}\n`))
const fatal = (...msgs) => fail() || log(...msgs) || process.exit(1)

let timer
let current

// Output a command to the terminal and execute it.
function run (cmd) {
  capture(cmd)
}

// Ask a question in terminal and return the response.
function prompt (question) {
  print(`${BOLD}${CYAN}?${RESET} ${BOLD}${question}${RESET} `)

  const { stdout } = spawnSync('bash', ['-c', 'read answer && echo $answer'], {
    encoding: 'utf8',
    stdio: ['inherit']
  })

  return stdout
}

// Ask whether to continue and otherwise exit the process.
function checkpoint (question) {
  const answer = prompt(`${question} [Y/n]`).trim()
  const prefix = `\r${PREVIOUS}${BOLD}${CYAN}?${RESET}`

  question = `${BOLD}${question}${RESET}`

  if (answer && answer.toLowerCase() !== 'y') {
    print(`\r${prefix} ${question} ${BOLD}${CYAN}No${RESET}${ERASE}\n`)
    process.exit(0)
  } else {
    print(`\r${prefix} ${question} ${BOLD}${CYAN}Yes${RESET}${ERASE}\n`)
  }
}

// Run a command and capture its output to return it to the caller.
function capture (cmd) {
  if (flags.debug) {
    log(`${GRAY}> ${cmd}${RESET}`)
  }

  const result = spawnSync(cmd, { encoding: 'utf8', shell: true })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const err = new Error(`Command failed: ${cmd}\n${result.stderr}`)
    for (const [k, v] of Object.entries(result)) {
      err[k] = v
    }
    throw err
  }

  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()

  if (flags.debug) {
    log(stdout)
    log(`${RED}${stderr}${RESET}`)
  }

  if (result.status) {
    throw new Error(stderr)
  }

  return stdout
}

// Start an operation and show a spinner until it reports as passing or failing.
function start (title) {
  current = title

  spin(0)
}

// Show a spinner for the current operation.
function spin (index) {
  if (flags.debug || process.env.CI) return

  print(`\r${CYAN}${frames[index]}${RESET} ${BOLD}${current}${RESET}`)

  timer = setTimeout(spin, 80, index === frames.length - 1 ? 0 : index + 1)
}

// Finish the current operation as passing.
function pass (result) {
  if (!current) return

  clearTimeout(timer)

  if (!flags.debug) {
    print(`\r${GREEN}✔${RESET} ${BOLD}${current}${RESET}`)

    if (result) {
      print(`: ${BOLD}${CYAN}${result}${RESET}`)
    }

    if (!process.env.CI) {
      print('\n')
    }
  }

  current = undefined
}

// Finish the current operation as failing.
function fail (err) {
  if (!current) return

  clearTimeout(timer)

  if (!flags.debug) {
    print(`\r${RED}✘${RESET} ${BOLD}${current}${RESET}`)

    if (!process.env.CI) {
      print('\n')
    }
  }

  current = undefined

  if (err) {
    throw err
  }
}

// Parse CLI arguments into parameters and flags.
function parse () {
  const args = process.argv.slice(2)
  const params = []
  const flags = {}

  for (const arg of args) {
    if (arg.startsWith('-')) {
      const name = arg.replace(/^-+/, '')
      flags[name] = true
    } else {
      params.push(arg)
    }
  }

  return { params, flags }
}

module.exports = {
  capture,
  checkpoint,
  fail,
  fatal,
  flags,
  log,
  params,
  pass,
  run,
  start
}
