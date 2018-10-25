'use strict'

module.exports = () => {
  const interpreter = process.jsEngine || 'v8'

  return {
    runtime: {
      name: 'nodejs',
      version: process.version
    },
    interpreter: {
      name: interpreter,
      version: process.versions[interpreter]
    }
  }
}
