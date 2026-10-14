'use strict'

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
// The ordinary loader can subsequently observe the same constructor.
require('mocha')

const mocha = new Mocha()
for (const file of process.argv.slice(2)) mocha.addFile(file)
mocha.run(failures => { process.exitCode = failures ? 1 : 0 })
