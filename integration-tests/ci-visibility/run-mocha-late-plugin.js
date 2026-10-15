'use strict'

const tracer = require('dd-trace').init({
  isCiVisibility: true,
  plugins: process.env.MOCHA_LATE_PLUGIN_MODE !== 'plugins-false',
  startupLogs: false,
  experimental: { exporter: 'datadog' },
})
tracer.use('fs', false)
tracer.use('child_process', false)
if (process.env.MOCHA_LATE_PLUGIN_MODE === 'use-false') tracer.use('mocha', false)

const MochaPackage = require('mocha')
const Mocha = MochaPackage.default ?? MochaPackage
const mocha = new Mocha()
for (const file of process.argv.slice(2)) mocha.addFile(file)
mocha.loadFiles()

tracer.use('mocha', true)
mocha.run(failures => { process.exitCode = failures ? 1 : 0 })
