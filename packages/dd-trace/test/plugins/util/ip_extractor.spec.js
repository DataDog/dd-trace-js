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
      .listen(0, 'localhost', () => {
        port = server.address().port
        done()
      })
  })

  after(() => {
    appListener && appListener.close()
  })

  function testIp (headers, expected, done) {
    controller = function (req) {
      const ip = extractIp({}, req)
      try {
        expect(ip).to.be.equal(expected)
        done()
      } catch (e) {
        done(e)
      }
    }

    axios.get(`http://localhost:${port}/`, { headers }).catch(done)
  }

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

      testIp({ [ipHeader]: expectedIp }, expectedIp, done)
    })

    it(`should detect ipv6 in header '${ipHeader}'`, (done) => {
      const expectedIp = '5a54:f844:006c:b8f1:0e96:9e54:54ac:4a2d'

      testIp({ [ipHeader]: expectedIp }, expectedIp, done)
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
    const invalidIp = 'evil-ip'
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
        [clientIpHeader]: invalidIp
      }
    }).catch(done)
  })

  it('should detect first public ip from multiple header configured', (done) => {
    const ip1 = '1.2.3.4'
    const ip2 = '1.2.3.5'
    const ip3 = '1.2.3.6'

    testIp({
      'x-forwarded-for': ip1,
      'x-client-ip': ip2,
      'true-client-ip': ip3
    }, ip1, done)
  })

  it('should detect first public ip from multiple header configured with ipv6', (done) => {
    const ip1 = '2f0e:8a33:3211:6e69:e1e0:63d1:919e:4477'
    const ip2 = '4498:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip3 = 'faa4:bf6b:fc08:5fa6:a58d:bd95:c23a:69a9'

    testIp({
      'x-forwarded-for': ip1,
      'x-client-ip': ip2,
      'true-client-ip': ip3
    }, ip1, done)
  })

  it('should detect first public ip', (done) => {
    const ip1 = '192.168.10.1'
    const ip2 = '172.16.3.5'
    const expectedIp = '1.2.3.4'
    const ip4 = '1.2.3.6'

    testIp({
      'x-forwarded-for': `${ip1},${ip2},${expectedIp},${ip4}`
    }, expectedIp, done)
  })

  it('should detect first public ipv6', (done) => {
    const ip1 = '192.168.10.1'
    const ip2 = 'fec0:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const expectedIp = '4498:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip4 = '::1'

    testIp({
      'x-forwarded-for': `${ip1},${ip2},  ${expectedIp} ,${ip4}`
    }, expectedIp, done)
  })

  it('should detect first private ip when all ips are private', (done) => {
    const expectedIp = '192.168.10.1'
    const ip2 = '172.16.3.5'

    testIp({
      'x-forwarded-for': `${expectedIp},${ip2}`
    }, expectedIp, done)
  })

  it('should detect first private ip when all ips are private ipv6', (done) => {
    const expectedIp = 'fec0:cf69:6a7b:49b6:8728:62d3:67ce:1fe7'
    const ip2 = '::1'

    testIp({
      'x-forwarded-for': `${expectedIp},${ip2}`
    }, expectedIp, done)
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

    testIp({
      'x-forwarded-for': ip1,
      'x-client-ip': ip2,
      'true-client-ip': ip3
    }, ip3Public, done)
  })

  describe('Forwarded header', () => {
    it('should detect ip in header \'Forwarded\' in for', (done) => {
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
          Forwarded: `for=${expectedIp}`
        }
      }).catch(done)
    })

    it('should not detect ip in header \'Forwarded\' in by', (done) => {
      const expectedIp = '127.0.0.1'
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
          Forwarded: 'by=1.2.3.4'
        }
      }).catch(done)
    })

    it('should detect ipv6 in header \'Forwarded\' in for', (done) => {
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
          Forwarded: `for="[${expectedIp}]"`
        }
      }).catch(done)
    })

    it('should detect ipv6 in header \'Forwarded\' in by', (done) => {
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
          Forwarded: `by="8.8.8.8";for=[${${expectedIp}}]`
        }
      }).catch(done)
    })

    it('should not detect ip in header \'Forwarded\' in by when for is private', (done) => {
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
          Forwarded: `for=192.168.0.1;by=${expectedIp}`
        }
      }).catch(done)
    })

    it('should detect ip in header \'Forwarded\' in for when for and by are public', (done) => {
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
          Forwarded: `by=5.6.7.8;for=${expectedIp}`
        }
      }).catch(done)
    })

    it('should detect ip in header \'x-client-ip\' when \'Forwarded\' is also set', (done) => {
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
          'x-client-ip': expectedIp,
          Forwarded: 'for=5.6.7.8'
        }
      }).catch(done)
    })

    it('should detect ip in header \'Forwarded\' when \'forwarded-for\' is also set', (done) => {
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
          'forwarded-for': '5.6.7.8',
          Forwarded: `for=${expectedIp}`
        }
      }).catch(done)
    })

    it('should detect ip in header \'Forwarded\' when \'host\' and \'proto\' are also set', (done) => {
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
          Forwarded: `for=${expectedIp};proto=http;host=testhost`
        }
      }).catch(done)
    })

    it('should detect ip in header \'Forwarded\' when port is included in the IP', (done) => {
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
          Forwarded: `for=${expectedIp}:8080`
        }
      }).catch(done)
    })

    it('should detect ip in header \'Forwarded\' when port is included in the IPv6', (done) => {
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
          Forwarded: `for=[${expectedIp}]:8080`
        }
      }).catch(done)
    })
  })
})
