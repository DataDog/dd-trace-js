'use strict'

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

const helpers = {
  baseSpecCheck (done, agent, operation, serviceName, klass, fixture, key, metadata, config) {
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

        if (config) {
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

  baseSpecCallback (done, agent, service, operation, serviceName, klass, fixture, key, metadata, config) {
    service[operation](fixture, (err, data) => {
      this.baseSpecCheck(done, agent, operation, serviceName, klass, fixture, key, metadata, config)
    })
  },

  baseSpecAsync (done, agent, service, operation, serviceName, klass, fixture, key, metadata, config) {
    this.baseSpecCheck(done, agent, operation, serviceName, klass, fixture, key, metadata, config)

    const serviceRequest = service[operation](fixture)
    serviceRequest.send()
  },

  baseSpecPromise (done, agent, service, operation, serviceName, klass, fixture, key, metadata, config) {
    const baseSpecCheck = this.baseSpecCheck
    function checkTraces () {
      baseSpecCheck(done, agent, operation, serviceName, klass, fixture, key, metadata, config)
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
  }
}

module.exports = helpers
