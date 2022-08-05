const { moduleLoadStart } = require('../channel-itm')

const savedDependencies = []
const detectedDependencyNames = new Set()

async function start (config, application, host) {
  const interval = setInterval(() => {
    if (savedDependencies.length > 0) {
      const depsToSend = savedDependencies.splice(0, 500)
      // TODO call to send data with payload etc.
    }
  })
  interval.unref()

  moduleLoadStart.subscribe((data) => {
    // TODO
    //  Check that the module name is not already loaded
    //  Check that is a dependency, and not an internal module ignore require('./<path/filename>')
    //      only accept require('module-name')
    //  Get name from data and its version from package.json
    //  Add it to savedDependencies
  })
}

module.exports = { start }
