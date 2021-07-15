'use strict'

/* eslint-disable no-console */

const path = require('path')
const os = require('os')
const fs = require('fs')
const mkdirp = require('mkdirp')
const axios = require('axios')
const tar = require('tar')

const fetch = (url, options) => {
  console.log(`GET ${url}`)

  return axios.get(url, options)
    .catch(() => axios.get(url, options))
    .catch(() => axios.get(url, options))
}

downloadAppSecBinaries()
  .then(extractAppSecBinaries)
  .catch(e => {
    process.exitCode = 1
    console.error(e)
  })

function downloadAppSecBinaries () {
  return fetch('https://api.github.com/repos/sqreen/libsqreen-binaries-public/tarball/master', {
    timeout: 5000,
    responseType: 'stream'
  }).then(response => {
    const outputPath = path.join(os.tmpdir(), 'appseclib.tgz')

    return new Promise((resolve, reject) => {
      response.data.pipe(fs.createWriteStream(outputPath))
        .on('finish', () => resolve(outputPath))
        .on('error', reject)
    })
  })
}

function extractAppSecBinaries (outputPath) {
  const extractPath = path.join(__dirname, '..', 'lib')

  mkdirp.sync(extractPath)

  return tar.extract({
    file: outputPath,
    cwd: extractPath,
    strip: 1
  })
}
