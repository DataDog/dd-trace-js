const NodeEnvironment = require('jest-environment-jsdom')

module.exports = class DatadogJestEnvironment extends NodeEnvironment {
  constructor (config, context) {
    super(config, context)
    this.filePath = context.testPath.replace(`${config.rootDir}/`, '')
  }
  async setup () {
    this.global.tracer = require('../../dd-trace').init({
      sampleRate: 1
    })
    await super.setup()
  }
  async handleTestEvent (event) {
    if (event.name === 'test_start') {
      const originalSpecFunction = event.test.fn
      if (originalSpecFunction.length) {
        event.test.fn = this.global.tracer.wrap(event.test.name, { type: 'test' }, () => {
          this.global.tracer
            .scope()
            .active()
            .addTags({
              'test.type': 'test',
              'test.name': `${event.test.parent.name} ${event.test.name}`,
              'test.suite': this.filePath
            })
          return new Promise((resolve, reject) => {
            originalSpecFunction((err) => {
              if (err) {
                this.global.tracer.scope().active().setTag('test.status', 'fail')
                reject(err)
              } else {
                this.global.tracer.scope().active().setTag('test.status', 'pass')
                resolve()
              }
            })
          })
        })
      } else {
        event.test.fn = this.global.tracer.wrap(event.test.name, { type: 'test' }, () => {
          let result
          this.global.tracer
            .scope()
            .active()
            .addTags({
              'test.type': 'test',
              'test.name': `${event.test.parent.name} ${event.test.name}`,
              'test.suite': this.filePath
            })
          try {
            result = originalSpecFunction()
            this.global.tracer.scope().active().setTag('test.status', 'pass')
          } catch (error) {
            this.global.tracer.scope().active().setTag('test.status', 'fail')
            throw error
          }

          if (result && result.then) {
            return result
              .then(() => {
                this.global.tracer.scope().active().setTag('test.status', 'pass')
              })
              .catch((err) => {
                this.global.tracer.scope().active().setTag('test.status', 'fail')
                throw err
              })
          }
          return result
        })
      }
    }
  }
}

