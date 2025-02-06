#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

const path = require('path')
const { writeFileSync } = require('fs')
const { execSync } = require('child_process')

const ddtracePath = path.join(__dirname, '..')
const defaultTestPath = process.env.DD_ST_PATH || path.join(ddtracePath, '..', 'system-tests')

const { buildAll, npm, testDir, testArgs } = parseArgs()

const binariesPath = path.join(testDir, 'binaries')

if (npm) {
  console.log('Using NPM package:', npm)

  writeFileSync(path.join(binariesPath, 'nodejs-load-from-npm'), npm)
} else {
  console.log('Using local repo')

  const packName = execSync(`npm pack ${ddtracePath}`, {
    cwd: binariesPath,
    stdio: [null, null, 'inherit'],
    encoding: 'utf8'
  }).slice(0, -1) // remove trailing newline

  writeFileSync(path.join(binariesPath, 'nodejs-load-from-npm'), `/binaries/${packName}`)
}

try {
  execSync(`./build.sh ${buildAll ? '' : '-i weblog'} && ./run.sh ${testArgs}`, {
    cwd: testDir,
    stdio: [null, 'inherit', 'inherit']
  })
} catch (err) {
  process.exit(err.status || 1)
}

function parseArgs () {
  const args = {
    buildAll: false,
    npm: null,
    testDir: defaultTestPath,
    testArgs: ''
  }

  for (let i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case '-b':
      case '--build-all':
        args.buildAll = true
        break

      case '-h':
      case '--help':
        helpAndExit()
        break

      case '-n':
      case '--npm': {
        const arg = process.argv[i + 1]
        if (!arg || arg[0] === '-') {
          args.npm = 'dd-trace'
        } else {
          args.npm = arg
          i++
        }
        break
      }

      case '-t':
      case '--test-dir': {
        const arg = process.argv[++i]
        if (!arg || arg[0] === '-') helpAndExit()
        args.testDir = arg
        break
      }

      case '--':
        args.testArgs = process.argv.slice(i + 1).join(' ')
        return args

      default:
        console.log('Unknown option:', process.argv[i], '\n')
        helpAndExit()
    }
  }

  return args
}

function helpAndExit () {
  console.log('Usage: node st.js [options...] [-- test-args]')
  console.log('Options:')
  console.log('  -b, --build-all       Rebuild all images (default: only build weblog)')
  console.log('  -h, --help            Print this message')
  console.log('  -n, --npm [package]   Build a remote package instead of the local repo (default: "dd-trace")')
  console.log('                        Can be a package name (e.g. "dd-trace@4.2.0") or a git URL (e.g.')
  console.log('                        "git+https://github.com/DataDog/dd-trace-js.git#mybranch")')
  console.log('  -t, --test-dir <path> Specify the system-tests directory (default: "dd-trace/../system-tests/")')
  console.log('  -- <test-args>        Passed to system-tests run.sh (e.g. "-- SCENARIO_NAME tests/path_to_test.py")')
  process.exit()
}
