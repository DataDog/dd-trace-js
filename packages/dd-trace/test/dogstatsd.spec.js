'use strict'

wrapIt()

describe('dogstatsd', () => {
  let client
  let Client
  let dgram
  let udp4
  let udp6
  let dns

  beforeEach(() => {
    udp6 = {
      send: sinon.spy(),
      on: sinon.stub().returns(udp6),
      unref: sinon.stub().returns(udp6)
    }

    udp4 = {
      send: sinon.spy(),
      on: sinon.stub().returns(udp4),
      unref: sinon.stub().returns(udp4)
    }

    dgram = {
      createSocket: sinon.stub()
    }
    dgram.createSocket.withArgs('udp4').returns(udp4)
    dgram.createSocket.withArgs('udp6').returns(udp6)

    dns = {
      lookup: sinon.stub()
    }

    dns.lookup.callsFake((hostname, callback) => {
      callback(new Error())
    })

    dns.lookup.withArgs('localhost').callsFake((hostname, callback) => {
      callback(null, '127.0.0.1', 4)
    })

    dns.lookup.withArgs('127.0.0.1').callsFake((hostname, callback) => {
      callback(null, hostname, 4)
    })

    dns.lookup.withArgs('::1').callsFake((hostname, callback) => {
      callback(null, hostname, 6)
    })

    Client = proxyquire('../src/dogstatsd', {
      'dgram': dgram,
      'dns': dns
    })
  })

  it('should send gauges', () => {
    client = new Client()

    client.gauge('test.avg', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g\n')
    expect(udp4.send.firstCall.args[1]).to.equal(0)
    expect(udp4.send.firstCall.args[2]).to.equal(14)
    expect(udp4.send.firstCall.args[3]).to.equal(8125)
    expect(udp4.send.firstCall.args[4]).to.equal('127.0.0.1')
  })

  it('should send counters', () => {
    client = new Client()

    client.increment('test.count', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:10|c\n')
    expect(udp4.send.firstCall.args[2]).to.equal(16)
  })

  it('should send multiple metrics', () => {
    client = new Client()

    client.gauge('test.avg', 10)
    client.increment('test.count', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g\ntest.count:10|c\n')
    expect(udp4.send.firstCall.args[2]).to.equal(30)
  })

  it('should support tags', () => {
    client = new Client()

    client.gauge('test.avg', 10, ['foo:bar', 'baz:qux'])
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g|#foo:bar,baz:qux\n')
    expect(udp4.send.firstCall.args[2]).to.equal(31)
  })

  it('should buffer metrics', () => {
    const value = new Array(1000).map(() => 'a').join()
    const tags = [`foo:${value}`]

    client = new Client()

    client.gauge('test.avg', 1, tags)
    client.gauge('test.avg', 1, tags)
    client.flush()

    expect(udp4.send).to.have.been.calledTwice
  })

  it('should not flush if the queue is empty', () => {
    client = new Client()

    client.flush()

    expect(udp4.send).to.not.have.been.called
    expect(udp6.send).to.not.have.been.called
    expect(dns.lookup).to.not.have.been.called
  })

  it('should not flush if the dns lookup fails', () => {
    client = new Client({
      host: 'invalid'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(dns.lookup).to.have.been.called
    expect(udp4.send).to.not.have.been.called
    expect(udp6.send).to.not.have.been.called
  })

  it('should not call DNS if the host is an IPv4 address', () => {
    client = new Client({
      host: '127.0.0.1'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(dns.lookup).to.not.have.been.called
  })

  it('should not call DNS if the host is an IPv6 address', () => {
    client = new Client({
      host: '2001:db8:3333:4444:5555:6666:7777:8888'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(udp6.send).to.have.been.called
    expect(dns.lookup).to.not.have.been.called
  })

  it('should support configuration', () => {
    client = new Client({
      host: '::1',
      port: 7777,
      prefix: 'prefix.',
      tags: ['foo:bar']
    })

    client.gauge('test.avg', 1, ['baz:qux'])
    client.flush()

    expect(udp6.send).to.have.been.called
    expect(udp6.send.firstCall.args[0].toString()).to.equal('prefix.test.avg:1|g|#foo:bar,baz:qux\n')
    expect(udp6.send.firstCall.args[1]).to.equal(0)
    expect(udp6.send.firstCall.args[2]).to.equal(37)
    expect(udp6.send.firstCall.args[3]).to.equal(7777)
    expect(udp6.send.firstCall.args[4]).to.equal('::1')
  })
})
