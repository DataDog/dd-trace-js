'use strict'

require('../../setup/tap')

const { extractIp } = require('../../../src/plugins/util/ip_extractor')
const http = require('http')
const axios = require('axios')

describe('ip extractor', () => {
  let port, appListener, controller

  before(done => {
    const server = new http.Server(async (req, res) => {
      controller && await controller(req, res)
      res.writeHead(200)
      res.end(JSON.stringify({ message: 'OK' }))
    })
    appListener = server
      .listen('localhost', () => {
        port = server.address().port
        done()
      })
  })

  after(() => {
    appListener && appListener.close()
  })
  const ipHeaderList = [
    'x-forwarded-for',
    'x-real-ip',
    'true-client-ip',
    'x-client-ip',
    'forwarded-for',
    'x-cluster-client-ip',
    'fastly-client-ip',
    'cf-connecting-ip',
    'cf-connecting-ipv6'
  ]
  ipHeaderList.forEach(ipHeader => {
    it(`should detect ip in header '${ipHeader}'`, (done) => {
      const expectedIp = '1.2.3.4'
      controller = function (req) {
        const ip = extractIp({}, req)
        try {
          expect(ip).to.be.equal(expectedIp)
          done()
        } catch (e) {
          done(e)
        }
      }
      axios.get(`http://localhost:${port}/`, {
        headers: {
          [ipHeader]: expectedIp
        }
      }).catch(done)
    })

    it(`should detect ipv6 in header '${ipHeader}'`, (done) => {
      const expectedIp = '5a54:f844:006c:b8f1:0e96:9e54:54ac:4a2d'
      controller = function (req) {
        const ip = extractIp({}, req)
        try {
          expect(ip).to.be.equal(expectedIp)
          done()
        } catch (e) {
          done(e)
        }
      }
      axios.get(`http://localhost:${port}/`, {
        headers: {
          [ipHeader]: expectedIp
        }
      }).catch(done)
    })
  })

  it('should detect ip in custom ip header', (done) => {
    const clientIpHeader = 'x-custom-ip-header'
    const expectedIp = '1.2.3.4'
    controller = function (req) {
      const ip = extractIp({ clientIpHeader }, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        [clientIpHeader]: expectedIp
      }
    }).catch(done)
  })

  it('should detect ip in custom ipv6 header', (done) => {
    const clientIpHeader = 'x-custom-ip-header'
    const expectedIp = '5a54:f844:006c:b8f1:0e96:9e54:54ac:4a2d'
    controller = function (req) {
      const ip = extractIp({ clientIpHeader }, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        [clientIpHeader]: expectedIp
      }
    }).catch(done)
  })

  it('should not detect ip in custom header with wrong value', (done) => {
    const clientIpHeader = 'x-custom-ip-header'
    const expectedIp = 'evil-ip'
    controller = function (req) {
      const ip = extractIp({ clientIpHeader }, req)
      try {
        expect(ip).to.be.undefined
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        [clientIpHeader]: expectedIp
      }
    }).catch(done)
  })

  it('should detect first public ip from multiple header configured', (done) => {
    const ip1 = '1.2.3.4'
    const ip2 = '1.2.3.5'
    const ip3 = '1.2.3.6'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(ip1)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': ip1,
        'x-client-ip': ip2,
        'true-client-ip': ip3
      }
    }).catch(done)
  })

  it('should detect first public ip from multiple header configured with ipv6', (done) => {
    const ip1 = '2f0e:8a33:3211:6e69:e1e0:63d1:919e:4477'
    const ip2 = '4498:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip3 = 'faa4:bf6b:fc08:5fa6:a58d:bd95:c23a:69a9'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(ip1)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': ip1,
        'x-client-ip': ip2,
        'true-client-ip': ip3
      }
    }).catch(done)
  })

  it('should detect first public ip', (done) => {
    const ip1 = '192.168.10.1'
    const ip2 = '172.16.3.5'
    const expectedIp = '1.2.3.4'
    const ip4 = '1.2.3.6'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${ip1},${ip2},${expectedIp},${ip4}`
      }
    }).catch(done)
  })

  it('should detect first public ipv6', (done) => {
    const ip1 = '192.168.10.1'
    const ip2 = 'fec0:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const expectedIp = '4498:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip4 = '::1'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${ip1},${ip2},  ${expectedIp} ,${ip4}`
      }
    }).catch(done)
  })

  it('should detect first private ip when all ips are private', (done) => {
    const expectedIp = '192.168.10.1'
    const ip2 = '172.16.3.5'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${expectedIp},${ip2}`
      }
    }).catch(done)
  })

  it('should detect first private ip when all ips are private ipv6', (done) => {
    const expectedIp = 'fec0:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip2 = '::1'
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expectedIp)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': `${expectedIp},${ip2}`
      }
    }).catch(done)
  })

  it('should detect ::1 or 127.0.0.1 (socket address in test) if nothing is configured', (done) => {
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(['::1', '127.0.0.1']).to.include(ip)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`).catch(done)
  })

  it('should detect public ip between multiple headers', (done) => {
    const ip1 = '192.168.10.1'
    const ip2 = '192.168.10.2'
    const ip3Public = '1.2.3.4'
    const ip3 = `192.168.10.2,${ip3Public}`
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(ip3Public)
        done()
      } catch (e) {
        done(e)
      }
    }
    axios.get(`http://localhost:${port}/`, {
      headers: {
        'x-forwarded-for': ip1,
        'x-client-ip': ip2,
        'true-client-ip': ip3
      }
    }).catch(done)
  })
})
