'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const axios = require('axios').create({ validateStatus: null })
const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('passport-http', 'passport-http', version => {
  describe('passport-http instrumentation', () => {
    const passportVerifyChannel = dc.channel('datadog:passport:verify:finish')
    let port, server, subscriberStub

    before(() => {
      return agent.load(['http', 'express', 'passport', 'passport-http'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const passport = require('../../../versions/passport').get()
      const BasicStrategy = require(`../../../versions/passport-http@${version}`).get().BasicStrategy
      const app = express()

      function validateUser (req, username, password, done) {
        // support with or without passReqToCallback
        if (typeof done !== 'function') {
          done = password
          password = username
          username = req
        }

        // simulate db error
        if (username === 'error') return done('error')

        const users = [{
          _id: 1,
          username: 'test',
          password: '1234',
          email: 'testuser@ddog.com'
        }]

        const user = users.find(user => (user.username === username) && (user.password === password))

        if (!user) {
          return done(null, false)
        } else {
          return done(null, user)
        }
      }

      passport.use('basic', new BasicStrategy({
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: false
      }, validateUser))

      passport.use('basic-withreq', new BasicStrategy({
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: true
      }, validateUser))

      app.use(passport.initialize())
      app.use(express.json())

      app.get('/',
        passport.authenticate('basic', {
          successRedirect: '/grant',
          failureRedirect: '/deny',
          session: false
        })
      )

      app.get('/req',
        passport.authenticate('basic-withreq', {
          successRedirect: '/grant',
          failureRedirect: '/deny',
          session: false
        })
      )

      app.get('/grant', (req, res) => {
        res.send('Granted')
      })

      app.get('/deny', (req, res) => {
        res.send('Denied')
      })

      passportVerifyChannel.subscribe((data) => subscriberStub(data))

      server = app.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(() => {
      subscriberStub = sinon.stub()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not call subscriber when an error occurs', async () => {
      const res = await axios.get(`http://localhost:${port}/`, {
        headers: {
          // error:1234
          Authorization: 'Basic ZXJyb3I6MTIzNA=='
        }
      })

      expect(res.status).to.equal(500)
      expect(subscriberStub).to.not.be.called
    })

    it('should call subscriber with proper arguments on success', async () => {
      const res = await axios.get(`http://localhost:${port}/`, {
        headers: {
          // test:1234
          Authorization: 'Basic dGVzdDoxMjM0'
        }
      })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Granted')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-basic',
        login: 'test',
        user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' },
        success: true,
        abortController: new AbortController()
      })
    })

    it('should call subscriber with proper arguments on success with passReqToCallback set to true', async () => {
      const res = await axios.get(`http://localhost:${port}/req`, {
        headers: {
          // test:1234
          Authorization: 'Basic dGVzdDoxMjM0'
        }
      })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Granted')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-basic',
        login: 'test',
        user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' },
        success: true,
        abortController: new AbortController()
      })

      throw new Error('CI SHOULD FAIL')
    })

    it('should call subscriber with proper arguments on failure', async () => {
      const res = await axios.get(`http://localhost:${port}/`, {
        headers: {
          // test:1
          Authorization: 'Basic dGVzdDox'
        }
      })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Denied')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-basic',
        login: 'test',
        user: false,
        success: false,
        abortController: new AbortController()
      })
    })

    it('should block when subscriber aborts', async () => {
      subscriberStub = sinon.spy(({ abortController }) => {
        storage.getStore().req.res.writeHead(403).end('Blocked')
        abortController.abort()
      })

      const res = await axios.get(`http://localhost:${port}/`, {
        headers: {
          // test:1234
          Authorization: 'Basic dGVzdDoxMjM0'
        }
      })

      expect(res.status).to.equal(403)
      expect(res.data).to.equal('Blocked')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-basic',
        login: 'test',
        user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' },
        success: true,
        abortController: new AbortController()
      })
    })
  })
})
