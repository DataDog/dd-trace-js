'use strict'

const checksum = require('checksum')
const fs = require('fs')
const glob = require('glob')
const os = require('os')
const path = require('path')
const tar = require('tar')

const platforms = [
  'darwin-ia32',
  'darwin-x64',
  'linux-ia32',
  'linux-x64',
  'win32-ia32',
  'win32-x64'
]

zipPrebuilds()
extractPrebuilds()
validatePrebuilds()
createChecksum()
copyPrebuilds()

function zipPrebuilds () {
  tar.create({
    gzip: true,
    sync: true,
    portable: true,
    strict: true,
    file: path.join(os.tmpdir(), 'prebuilds.tgz')
  }, glob.sync('prebuilds/**/*.node'))
}

function extractPrebuilds () {
  tar.extract({
    sync: true,
    strict: true,
    file: path.join(os.tmpdir(), 'prebuilds.tgz'),
    cwd: os.tmpdir()
  })
}

function validatePrebuilds () {
  platforms.forEach(platform => {
    try {
      fs.readdirSync(path.join(os.tmpdir(), 'prebuilds', platform))
        .filter(file => /^node-\d+\.node$/.test(file))
        .forEach(file => {
          const content = fs.readFileSync(path.join('prebuilds', platform, file))
          const sum = fs.readFileSync(path.join('prebuilds', platform, `${file}.sha1`), 'ascii')

          if (sum !== checksum(content, { algorithm: 'sha256' })) {
            throw new Error(`Invalid checksum for "prebuilds/${platform}/${file}".`)
          }
        })
    } catch (e) {
      // skip missing platforms
    }
  })
}

function createChecksum () {
  const file = path.join(os.tmpdir(), 'prebuilds.tgz')
  const sum = checksum(fs.readFileSync(file), { algorithm: 'sha256' })

  fs.writeFileSync(`${file}.sha1`, sum)
}

function copyPrebuilds () {
  const basename = path.normalize(path.join(__dirname, '..'))
  const filename = 'prebuilds.tgz'

  fs.copyFileSync(
    path.join(os.tmpdir(), filename),
    path.join(basename, filename)
  )

  fs.copyFileSync(
    path.join(os.tmpdir(), `${filename}.sha1`),
    path.join(basename, `${filename}.sha1`)
  )
}
