'use strict'

/* eslint-disable no-console */

const path = require('path')
const os = require('os')
const fs = require('fs')
const mkdirp = require('mkdirp')
const execSync = require('child_process').execSync
const semver = require('semver')
const checksum = require('checksum')
const axios = require('axios')
const tar = require('tar')

const platform = os.platform()
const arch = process.env.ARCH || os.arch()

const { NODE_VERSIONS = '>=10' } = process.env

// https://nodejs.org/en/download/releases/
const targets = [
  { version: '8.0.0', abi: '57' },
  { version: '9.0.0', abi: '59' },
  { version: '10.0.0', abi: '64' },
  { version: '11.0.0', abi: '67' },
  { version: '12.0.0', abi: '72' },
  { version: '13.0.0', abi: '79' },
  { version: '14.0.0', abi: '83' },
  { version: '15.0.0', abi: '88' },
  { version: '16.0.0', abi: '93' }
].filter(target => semver.satisfies(target.version, NODE_VERSIONS))

const fetch = (url, options) => {
  console.log(`GET ${url}`)

  return axios.get(url, options)
    .catch(() => axios.get(url, options))
    .catch(() => axios.get(url, options))
}

downloadAppSecBinaries()
  .then(extractAppSecBinaries)
  .then(prebuildify)
  .catch(e => {
    process.exitCode = 1
    console.error(e)
  })

function downloadAppSecBinaries () {
  return fetch('https://api.github.com/repos/sqreen/libsqreen-binaries-public/tarball/master', {
    timeout: 5000,
    responseType: 'stream'
  }).then(response => {
    const outputPath = path.join(os.tmpdir(), 'appsecbin.tgz')

    return new Promise((resolve, reject) => {
      response.data.pipe(fs.createWriteStream(outputPath))
        .on('finish', () => resolve(outputPath))
        .on('error', reject)
    })
  })
}

function extractAppSecBinaries (outputPath) {
  return tar.extract({
    file: outputPath,
    cwd: path.join(__dirname, '..', 'lib'),
    strip: 1
  })
}

function prebuildify () {
  const cache = path.join(os.tmpdir(), 'prebuilds')

  mkdirp.sync(cache)
  mkdirp.sync(`prebuilds/${platform}-${arch}`)

  targets.forEach(target => {
    const output = `prebuilds/${platform}-${arch}/node-${target.abi}.node`
    const cmd = [
      'node-gyp rebuild',
      `--target=${target.version}`,
      `--target_arch=${arch}`,
      `--devdir=${cache}`,
      '--release',
      '--jobs=max',
      '--build_v8_with_gn=false',
      '--v8_enable_pointer_compression=""',
      '--v8_enable_31bit_smis_on_64bit_arch=""',
      '--enable_lto=false'
    ].join(' ')

    execSync(cmd, { stdio: [0, 1, 2] })

    const sum = checksum(fs.readFileSync('build/Release/metrics.node'))

    fs.writeFileSync(`${output}.sha1`, sum)
    fs.copyFileSync('build/Release/metrics.node', output)
  })
}
