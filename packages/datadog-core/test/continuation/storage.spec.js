'use strict'

const { expect } = require('chai')
const Storage = require('../../src/continuation/storage')

describe('continuation/storage', () => {
  let storage

  beforeEach(() => {
    storage = new Storage()
  })

  it('should be a no-op when activating', done => {
    storage.run({}, () => {
      expect(storage.getStore()).to.be.undefined
      done()
    })
  })
})
