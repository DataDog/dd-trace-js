'use strict'

wrapIt()

describe('plugins/util/redis', () => {
  let redis
  let tracer
  let config
  let span

  beforeEach(() => {
    config = {}
    tracer = require('../../..').init({ service: 'test', plugins: false })
    redis = require('../../../src/plugins/util/redis')
  })

  describe('instrument', () => {
    it('should start a span with the correct tags', () => {
      span = redis.instrument(tracer, config, '1', 'set', ['foo', 'bar'])

      expect(span.context()._tags).to.deep.include({
        'span.kind': 'client',
        'service.name': 'test-redis',
        'resource.name': 'set',
        'span.type': 'redis',
        'db.type': 'redis',
        'db.name': '1',
        'out.host': '127.0.0.1',
        'out.port': '6379',
        'redis.raw_command': 'SET foo bar'
      })
    })

    it('should use the parent from the scope', () => {
      if (process.env.DD_CONTEXT_PROPAGATION === 'false') return

      const parent = tracer.startSpan('parent')

      tracer.scope().activate(parent, () => {
        span = redis.instrument(tracer, config, '1', 'ping', [])

        expect(span.context()._parentId.toString()).to.equal(parent.context()._spanId.toString())
      })
    })

    it('should trim command arguments if yoo long', () => {
      let key = ''

      for (let i = 0; i <= 100; i++) {
        key += 'a'
      }

      span = redis.instrument(tracer, config, '1', 'get', [key])

      const rawCommand = span.context()._tags['redis.raw_command']

      expect(rawCommand).to.have.length(104)
      expect(rawCommand.substr(0, 10)).to.equal('GET aaaaaa')
      expect(rawCommand.substr(94)).to.equal('aaaaaaa...')
    })

    it('should trim the command if too long', () => {
      const values = []

      for (let i = 0; i < 10; i++) {
        let value = ''

        for (let i = 0; i < 100; i++) {
          value += 'a'
        }

        values.push(value)
      }

      span = redis.instrument(tracer, config, '1', 'get', values)

      const rawCommand = span.context()._tags['redis.raw_command']

      expect(rawCommand).to.have.length(1000)
      expect(rawCommand.substr(0, 10)).to.equal('GET aaaaaa')
      expect(rawCommand.substr(990)).to.equal('aaaaaaa...')
    })

    it('should ignore arguments for authentication', () => {
      span = redis.instrument(tracer, config, '1', 'auth', ['username', 'password'])

      const rawCommand = span.context()._tags['redis.raw_command']

      expect(rawCommand).to.equal('AUTH')
    })
  })
})
