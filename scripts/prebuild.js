'use strict'

const prebuildify = require('prebuildify')
const abi = require('node-abi')
const fs = require('fs')
const path = require('path')
const os = require('os')
const archiver = require('archiver')

const name = `${process.env.ARCH || os.platform()}-${os.arch()}`

const opts = {
  targets: abi.supportedTargets.filter(target => target.runtime === 'node'),
  strip: false
}

const cb = err => {
  if (err) throw err

  const output = fs.createWriteStream(path.join(__dirname, '..', 'prebuilds', `addons-${name}.zip`))
  const archive = archiver('zip', {
    zlib: { level: 9 }
  })

  archive.on('error', function (err) {
    throw err
  })

  archive.pipe(output)
  archive.directory(path.join(__dirname, '..', 'prebuilds', name), name)
  archive.finalize()
}

prebuildify(opts, cb)
