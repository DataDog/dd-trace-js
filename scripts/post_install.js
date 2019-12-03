'use strict'

/* eslint-disable no-console */

const execSync = require('child_process').execSync
const path = require('path')
const tar = require('tar')
const fs = require('fs')
const os = require('os')

const name = `${os.platform()}-${os.arch()}`
const cwd = path.join(__dirname, '..')
const buildFromSource = process.env.npm_config_build_from_source
const platforms = [
  'linux-x64',
  'linux-ia32',
  'darwin-x64',
  'darwin-ia32',
  'win32-x64',
  'win32-ia32'
]

if (process.env.DD_NATIVE_METRICS !== 'false' && __dirname.indexOf('/node_modules/') !== -1) {
  if (buildFromSource === 'true' || buildFromSource === 'dd-trace' || !platforms.includes(name)) {
    extract()
      .then(rebuild)
      .then(cleanup)
  } else {
    extract()
      .catch(rebuild)
      .then(cleanup)
  }
}

function rebuild () {
  console.log('Trying to compile new binaries.')

  try {
    execSync('npm run install:rebuild --silent --scripts-prepend-node-path', { stdio: [0, 1, 2] })
  } catch (e) {
    console.log([
      'Compilation of native modules failed.',
      'Falling back to JavaScript only.',
      'Some functionalities may not be available.'
    ].join(' '))
  }
}

function extract () {
  console.log('Extracting prebuilt binaries.')

  const promise = tar.extract({
    file: `prebuilds.tgz`,
    cwd: path.join(__dirname, '..')
  })

  promise.catch(() => {
    console.log('Extraction of prebuilt binaries failed.')
  })

  return promise
}

function cleanup () {
  try {
    fs.unlinkSync(path.join(cwd, `prebuilds.tgz`))
  } catch (e) {
    // Ignore as it's just to save space
  }
}
