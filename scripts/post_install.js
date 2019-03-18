'use strict'

/* eslint-disable no-console */

const execSync = require('child_process').execSync
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const tar = require('tar')
const pkg = require('../package.json')

const name = `${os.platform()}-${os.arch()}`

if (process.env.DD_NATIVE_METRICS !== 'false') {
  getReleaseTag()
    .then(download)
    .then(extract)
    .then(cleanup)
    .catch(rebuild)
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

function download (tag) {
  console.log('Downloading prebuilt binaries for native addons.')

  const promise = new Promise((resolve, reject) => {
    const folder = path.join(__dirname, '..', 'prebuilds')
    const url = `https://github.com/DataDog/dd-trace-js/releases/download/${tag}/addons-${name}.zip`

    const req = https.get(url, res => {
      if (res.statusCode !== 200) {
        return reject(new Error('Server replied with not OK status code.'))
      }

      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder)
      }

      const file = fs.createWriteStream(path.join(__dirname, '..', 'prebuilds', `addons-${name}.zip`))
      const stream = res.pipe(file)

      stream.on('error', reject)
      stream.on('finish', () => resolve())
    })

    req.on('error', reject)
  })

  promise.catch(() => {
    console.log('Download of prebuilt binaries failed.')
  })

  return promise
}

function extract () {
  console.log('Extracting prebuilt binaries.')

  const promise = tar.extract({
    file: `addons-${name}.tgz`,
    cwd: path.join(__dirname, '..', 'prebuilds')
  })

  promise.catch(() => {
    console.log('Extraction of prebuilt binaries failed.')
  })

  return promise
}

function cleanup () {
  fs.unlink(`addons-${name}.tgz`, () => {})
}

function getReleaseTag () {
  if (/^\d+\.\d+\.\d+$/.test(pkg.version)) { // official release
    return Promise.resolve(`v${pkg.version}`)
  }

  const promise = new Promise((resolve, reject) => {
    const req = https.get(`https://github.com/DataDog/dd-trace-js/releases/latest`, res => {
      let data = ''

      if (res.statusCode !== 200) {
        return reject(new Error('Server replied with not OK status code.'))
      }

      res.on('data', chunk => {
        data += chunk
      })

      res.on('finish', () => {
        try {
          resolve(JSON.parse(data).tag_name)
        } catch (e) {
          reject(e)
        }
      })
    })

    req.on('error', reject)
  })

  promise.catch(() => {
    console.log('Unable to determine prebuilt binaries download location.')
  })

  return promise
}
