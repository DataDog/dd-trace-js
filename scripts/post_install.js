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
  download(`v${pkg.version}`)
    .catch(() => getLatestTag().then(download))
    .then(persist)
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

function locate (url) {
  const promise = new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      res.resume()

      if (!res.headers.location) {
        reject(new Error('Unable to determine prebuilt binaries download location.'))
      }

      resolve(res.headers.location)
    })

    req.on('error', reject)
  })

  return promise
}

function download (tag) {
  console.log(tag)
  console.log(`Downloading prebuilt binaries for ${tag} native addons.`)

  const promise = locate(`https://github.com/DataDog/dd-trace-js/releases/download/${tag}/addons-${name}.tgz`)
    .then(url => {
      return new Promise((resolve, reject) => {
        const req = https.get(url, res => {
          if (res.statusCode !== 200) {
            return reject(new Error('Server replied with not OK status code.'))
          }

          resolve(res)
        })

        req.on('error', reject)
      })
    })

  promise.catch((e) => {
    console.log(`Download of prebuilt binaries for ${tag} failed.`)
  })

  return promise
}

function persist (res) {
  const promise = new Promise((resolve, reject) => {
    const file = fs.createWriteStream(path.join(__dirname, '..', `addons-${name}.tgz`))
    const stream = res.pipe(file)

    stream.on('error', reject)
    stream.on('finish', () => resolve())
  })

  promise.catch(() => {
    console.log('Writing prebuilt binaries to disk failed.')
  })

  return promise
}

function extract () {
  console.log('Extracting prebuilt binaries.')

  const promise = tar.extract({
    file: `addons-${name}.tgz`,
    cwd: path.join(__dirname, '..')
  })

  promise.catch(() => {
    console.log('Extraction of prebuilt binaries failed.')
  })

  return promise
}

function cleanup () {
  fs.unlink(`addons-${name}.tgz`, () => {})
}

function getLatestTag () {
  const promise = new Promise((resolve, reject) => {
    const req = https.get(`https://github.com/DataDog/dd-trace-js/releases/latest`, res => {
      const match = res.headers.location && res.headers.location.match(/^.+\/(.+)$/)

      res.resume()

      if (!match || !match[1]) {
        return reject(new Error('Could not get the latest release tag.'))
      }

      resolve(match[1])
    })

    req.on('error', reject)
  })

  promise.catch(() => {
    console.log('Unable to determine prebuilt binaries download location.')
  })

  return promise
}
