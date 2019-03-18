'use strict'

const prebuildify = require('prebuildify')
const abi = require('node-abi')
const path = require('path')
const os = require('os')
const tar = require('tar')

const name = `${os.platform()}-${process.env.ARCH || os.arch()}`

const cb = err => {
  if (err) throw err

  tar.create({
    gzip: true,
    sync: true,
    portable: true,
    file: `addons-${name}.tgz`,
    cwd: path.join(__dirname, '..', 'prebuilds')
  }, [name])
}

prebuildify({
  targets: abi.supportedTargets.filter(target => target.runtime === 'node'),
  strip: false
}, cb)
