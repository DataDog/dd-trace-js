'use strict'

exports.mochaHooks = {
  beforeAll () {
    process.stdout.write('global before hook\n')
  },
  afterAll () {
    process.stdout.write('global after hook\n')
  },
  beforeEach () {
    process.stdout.write('global beforeEach hook\n')
  },
  afterEach () {
    process.stdout.write('global afterEach hook\n')
  },
}
