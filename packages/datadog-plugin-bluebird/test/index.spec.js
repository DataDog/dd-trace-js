'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('bluebird')

assertPromise('bluebird', bluebird => {
  // TODO: remove if statement when running tests only for versions ^2.11.0 and ^3.4.1
  // https://github.com/petkaantonov/bluebird/releases/tag/v2.11.0
  // https://github.com/petkaantonov/bluebird/releases/tag/v3.4.1
  if (!bluebird.getNewLibraryCopy) {
    return bluebird
  }

  return bluebird.getNewLibraryCopy()
})

describe('bluebird.getNewLibraryCopy', () => {
  let bluebird
  const agent = require('../../dd-trace/test/plugins/agent')
  const plugin = require('../src')
  const unpatch = plugin[0]['unpatch']
  const mockIntegrations = {
    unwrap: sinon.spy()
  }

  wrapIt()

  describe('library copies to unpatch', () => {
    withVersions(plugin, 'bluebird', version => {
      beforeEach(() => {
        agent.load(plugin, 'bluebird')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          bluebird = require(`../../../versions/bluebird@${version}`).get()
        })

        describe('patching', () => {
          it('should create a hidden property on original promise', () => {
            if (bluebird.getNewLibraryCopy) {
              bluebird.getNewLibraryCopy()

              expect(bluebird['_datadog_library_copies']).to.exist
            }
          })

          it('should add library copies to hidden property on original promise', () => {
            if (bluebird.getNewLibraryCopy) {
              const bluebirdCopyOne = bluebird.getNewLibraryCopy()
              const bluebirdCopyTwo = bluebird.getNewLibraryCopy()

              expect(bluebird['_datadog_library_copies']).to.contain(bluebirdCopyOne)
              expect(bluebird['_datadog_library_copies']).to.contain(bluebirdCopyTwo)
            }
          })
        })

        describe('unpatching', () => {
          it('should remove hidden property on original promise', () => {
            if (bluebird.getNewLibraryCopy) {
              bluebird.getNewLibraryCopy()

              expect(bluebird['_datadog_library_copies']).to.exist

              unpatch.call(mockIntegrations, bluebird)

              expect(bluebird['_datadog_library_copies']).to.not.exist
            }
          })

          it('should unwrap library copies', () => {
            if (bluebird.getNewLibraryCopy) {
              const bluebirdCopyOne = bluebird.getNewLibraryCopy()
              const bluebirdCopyTwo = bluebird.getNewLibraryCopy()

              unpatch.call(mockIntegrations, bluebird)

              expect(mockIntegrations.unwrap).to.have.been.calledWithMatch(bluebirdCopyOne.prototype, '_then')
              expect(mockIntegrations.unwrap).to.have.been.calledWithMatch(bluebirdCopyTwo.prototype, '_then')
            }
          })
        })
      })
    })
  })
})
