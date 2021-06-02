const { expect } = require('chai')
const fs = require('fs')

describe('mocha-test-integration', () => {
  it('can do integration tests', (done) => {
    fs.readFile('./package.json', () => {
      expect(true).to.equal(true)
      done()
    })
  })
})
