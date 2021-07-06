'use strict'

const path = require('path')
const os = require('os')
const fs = require('fs')
const mkdirp = require('mkdirp')
const execSync = require('child_process').execSync
const semver = require('semver')
const checksum = require('checksum')

const platform = os.platform()
const arch = process.env.ARCH || os.arch()

const { NODE_VERSIONS = '>=12' } = process.env

// https://nodejs.org/en/download/releases/
const targets = [
  { version: '12.0.0', abi: '72' },
  { version: '13.0.0', abi: '79' },
  { version: '14.0.0', abi: '83' },
  { version: '15.0.0', abi: '88' },
  { version: '16.0.0', abi: '93' }
].filter(target => semver.satisfies(target.version, NODE_VERSIONS))

prebuildify()

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

    const sum = checksum(fs.readFileSync('build/Release/metrics.node'), {
      algorithm: 'sha256'
    })

    fs.writeFileSync(`${output}.sha1`, sum)
    fs.copyFileSync('build/Release/metrics.node', output)
  })
}
