'use strict'

const path = require('path')
const os = require('os')
const fs = require('fs')
const mkdirp = require('mkdirp')
const execSync = require('child_process').execSync

const platform = os.platform()
const arch = process.env.ARCH || os.arch()

const { NODE_ABI } = process.env

// https://nodejs.org/en/download/releases/
const targets = [
  { version: '8.0.0', abi: '57' },
  { version: '9.0.0', abi: '59' },
  { version: '10.0.0', abi: '64' },
  { version: '11.0.0', abi: '67' },
  { version: '12.0.0', abi: '72' },
  { version: '13.0.0', abi: '79' }
].filter(target => !NODE_ABI || NODE_ABI.split(',').some(abi => target.abi === abi))

prebuildify()

function prebuildify () {
  const cache = path.join(os.tmpdir(), 'prebuilds')

  mkdirp.sync(cache)
  mkdirp.sync(`prebuilds/${platform}-${arch}`)

  targets.forEach(target => {
    const cmd = [
      'node-gyp rebuild',
      `--target=${target.version}`,
      `--target_arch=${arch}`,
      `--devdir=${cache}`,
      '--release',
      '--build_v8_with_gn=false',
      '--enable_lto=false'
    ].join(' ')

    execSync(cmd, { stdio: [0, 1, 2] })

    fs.copyFileSync('build/Release/metrics.node', `prebuilds/${platform}-${arch}/node-${target.abi}.node`)
  })
}
