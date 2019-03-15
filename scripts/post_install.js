'use strict'

/* eslint-disable no-console */

const execSync = require('child_process').execSync
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const pkg = require('../package.json')

if (process.env.DD_NATIVE_METRICS !== 'false') {
  download(err => {
    if (err) {
      console.log()
      console.log([
        'Download of prebuilt binaries failed.',
        'Attempting to compile new binaries.'
      ].join(' '))
      console.log()
    }

    try {
      execSync('npm run install:rebuild --scripts-prepend-node-path', { stdio: [0, 1, 2] })
    } catch (e) {
      console.log()
      console.log([
        'Compilation of native modules failed.',
        'Falling back to JavaScript only.',
        'Some functionalities may not be available.'
      ].join(' '))
      console.log()
    }
  })
}

function download (cb) {
  const folder = path.join(__dirname, '..', 'prebuilds')
  const name = `${os.platform()}-${os.arch()}`
  const version = ~pkg.version.indexOf('beta') ? 'latest' : `v${pkg.version}`
  const url = `https://github.com/DataDog/dd-trace-js/releases/download/${version}/addons-${name}.zip`

  const req = https.get(url, res => {
    if (res.statusCode !== 200) {
      return cb(new Error('Server replied with not OK status code.'))
    }

    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder)
    }

    const file = fs.createWriteStream(path.join(__dirname, '..', 'prebuilds', `addons-${name}.zip`))
    const stream = res.pipe(file)

    stream.on('finish', () => cb())
  })

  req.on('error', cb)
}
