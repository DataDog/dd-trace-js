'use strict'

const { dirname, join } = require('node:path')

const MochaPackage = require('mocha')
const { version } = require('mocha/package.json')
const Mocha = MochaPackage.default ?? MochaPackage

require('dd-trace').init({
  isCiVisibility: true,
  startupLogs: false,
  experimental: { exporter: 'datadog' },
})

const { channel } = require('dc-polyfill')
const loadChannel = channel('dd-trace:bundler:load')
const extension = Number.parseInt(version, 10) >= 12 ? 'cjs' : 'js'
for (const [file, module] of [
  ['suite', Mocha.Suite],
  ['runnable', Mocha.Runnable],
  ['runner', Mocha.Runner],
  ['mocha', Mocha],
]) {
  loadChannel.publish({ package: 'mocha', path: `mocha/lib/${file}.${extension}`, version, module })
}
let mocha
if (process.env.MOCHA_BUNDLER_METADATA_AFTER_UI === 'true') mocha = new Mocha()
// The ordinary loader can subsequently observe the same constructor.
require('mocha')
require(join(dirname(require.resolve('mocha/package.json')), 'lib', `mocha.${extension}`))

mocha ??= new Mocha()
for (const file of process.argv.slice(2)) mocha.addFile(file)
mocha.run(failures => { process.exitCode = failures ? 1 : 0 })
