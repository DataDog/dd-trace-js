'use strict'
const path = require('path')

if (Number(process.env.USE_TRACER)) {
  require('../../../ci/init')
}

const Mocha = require('../../../versions/mocha').get()

const mocha = new Mocha({
  reporter: function () {} // silent on internal tests
})
mocha.addFile(path.join(__dirname, 'test.js'))
mocha.addFile(path.join(__dirname, 'test-2.js'))
mocha.run()
