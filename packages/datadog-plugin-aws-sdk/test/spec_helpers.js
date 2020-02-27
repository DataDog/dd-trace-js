'use strict'

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

const helpers = {
  baseSpecCheck (done, agent, operation, serviceName, klass, fixture, key, metadata, testHooks) {
    agent
      .use(traces => {
        const spans = sort(traces[0])
        expect(spans[0]).to.have.property('resource', `${operation} ${fixture[key]}`)
        expect(spans[0]).to.have.property('name', 'aws.request')
        expect(spans[0].meta).to.have.property('aws.service', klass)
        expect(spans[0].service).to.include(serviceName)
        expect(spans[0].meta['aws.' + metadata]).to.be.a('string')
        expect(spans[0].meta['aws.region']).to.be.a('string')
        expect(spans[0].meta).to.have.property('aws.operation', operation)
        expect(spans[0].meta).to.have.property('component', 'aws-sdk')

        if (testHooks) {
          expect(traces[0][0].meta).to.have.property('aws.specialValue', 'foo')
          expect(traces[0][0].meta).to.have.property('aws.params' + key, fixture[key])
        }
      })
      .then(done)
      .catch(done)
  },

  baseSpecError (done, agent, service, operation, serviceName, klass, fixture, key, metadata) {
    service[operation]({
      [key]: fixture[key],
      'BadParam': 'badvalue'
    }, (err, response) => {
      agent.use(traces => {
        const spans = sort(traces[0])
        expect(spans[0]).to.have.property('resource', `${operation} ${fixture[key]}`)
        expect(spans[0]).to.have.property('name', 'aws.request')
        expect(spans[0].service).to.include(serviceName)
        expect(spans[0].meta).to.have.property('aws.service', klass)
        expect(spans[0].meta['aws.' + metadata]).to.be.a('string')
        expect(spans[0].meta['aws.region']).to.be.a('string')
        expect(spans[0].meta).to.have.property('aws.operation', operation)
        expect(spans[0].meta).to.have.property('component', 'aws-sdk')
        expect(spans[0].meta['error.type']).to.be.a('string')
        expect(spans[0].meta['error.msg']).to.be.a('string')
        expect(spans[0].meta['error.stack']).to.be.a('string')
      }).then(done).catch(done)
    })
  },

  baseSpecCallback (done, agent, service, operation, serviceName, klass, fixture, key, metadata, testHooks) {
    service[operation](fixture, (err, data) => {
      this.baseSpecCheck(done, agent, operation, serviceName, klass, fixture, key, metadata, testHooks)
    })
  },

  baseSpecAsync (done, agent, service, operation, serviceName, klass, fixture, key, metadata, testHooks) {
    this.baseSpecCheck(done, agent, operation, serviceName, klass, fixture, key, metadata, testHooks)

    const serviceRequest = service[operation](fixture)
    serviceRequest.send()
  },

  baseSpecPromise (done, agent, service, operation, serviceName, klass, fixture, key, metadata, testHooks) {
    const baseSpecCheck = this.baseSpecCheck
    function checkTraces () {
      baseSpecCheck(done, agent, operation, serviceName, klass, fixture, key, metadata, testHooks)
    }

    const serviceRequest = service[operation](fixture).promise()
    serviceRequest.then(checkTraces).catch(checkTraces)
  },

  baseSpecBindCallback (done, agent, service, operation, fixture, tracer) {
    let activeSpanName
    const parentName = 'parent'

    tracer.trace(parentName, () => {
      service[operation](fixture, () => {
        try {
          activeSpanName = tracer.scope().active()._spanContext._name
        } catch (e) {
          activeSpanName = undefined
        }

        expect(activeSpanName).to.equal(parentName)
        done()
      })
    })
  },

  baseSpecs (semver, version, agent, getService, operation, serviceName, klass, fixture, key, metadata, testHooks) {
    if (!testHooks) {
      it('should instrument service methods with a callback', (done) => {
        this.baseSpecCallback(done, agent, getService(), operation,
          serviceName, klass, fixture, key, metadata)
      })

      it('should instrument service methods without a callback', (done) => {
        this.baseSpecAsync(done, agent, getService(), operation,
          serviceName, klass, fixture, key, metadata)
      })

      it('should mark error responses', (done) => {
        this.baseSpecError(done, agent, getService(), operation,
          serviceName, klass, fixture, key, metadata)
      })

      if (semver.intersects(version, '>=2.3.0')) {
        it('should instrument service methods using promise()', (done) => {
          this.baseSpecPromise(done, agent, getService(), operation,
            serviceName, klass, fixture, key, metadata)
        })
      }

      it('should bind callbacks to the correct active span', (done) => {
        const tracer = require('../../dd-trace')
        this.baseSpecBindCallback(done, agent, getService(), operation, fixture, tracer)
      })
    } else {
      it('should handle hooks appropriately with a callback', (done) => {
        helpers.baseSpecCallback(done, agent, getService(), operation,
          serviceName, klass, fixture, key, metadata, testHooks)
      })

      it('should handle hooks appropriately without a callback', (done) => {
        helpers.baseSpecAsync(done, agent, getService(), operation,
          serviceName, klass, fixture, key, metadata, testHooks)
      })
    }
  }
}

module.exports = helpers
