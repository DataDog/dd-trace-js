const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')

class NycPlugin extends CiPlugin {
  static get id () {
    return 'nyc'
  }

  constructor (...args) {
    super(...args)

    this.addSub('ci:nyc:wrap', (nyc) => {
      if (nyc?.config?.all) {
        this.nyc = nyc
      }
    })

    this.addSub('ci:nyc:get-coverage', ({ onDone }) => {
      if (this.nyc?.getCoverageMapFromAllCoverageFiles) {
        this.nyc.getCoverageMapFromAllCoverageFiles()
          .then((untestedCoverageMap) => {
            this.nyc = null
            onDone(untestedCoverageMap)
          }).catch((e) => {
            this.nyc = null
            onDone()
          })
      } else {
        this.nyc = null
        onDone()
      }
    })
  }
}

module.exports = NycPlugin
