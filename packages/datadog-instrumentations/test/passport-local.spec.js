'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const axios = require('axios').create({ validateStatus: null })
const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

withVersions('passport-local', 'passport-local', version => {
  describe('passport-local instrumentation', () => {
    const passportVerifyChannel = dc.channel('datadog:passport:verify:finish')
    let port, server, subscriberStub

    before(() => {
      return agent.load(['http', 'express', 'passport', 'passport-local'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const passport = require('../../../versions/passport').get()
      const LocalStrategy = require(`../../../versions/passport-local@${version}`).get().Strategy
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

      passport.use('local', new LocalStrategy({
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: false
      }, validateUser))

      passport.use('local-withreq', new LocalStrategy({
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: true
      }, validateUser))

      app.use(passport.initialize())
      app.use(express.json())

      app.post('/',
        passport.authenticate('local', {
          successRedirect: '/grant',
          failureRedirect: '/deny',
          session: false
        })
      )

      app.post('/req',
        passport.authenticate('local-withreq', {
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
      const res = await axios.post(`http://localhost:${port}/`, { username: 'error', password: '1234' })

      expect(res.status).to.equal(500)
      expect(subscriberStub).to.not.be.called
    })

    it('should call subscriber with proper arguments on success', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { username: 'test', password: '1234' })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Granted')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-local',
        login: 'test',
        user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' },
        success: true,
        abortController: new AbortController()
      })
    })

    it('should call subscriber with proper arguments on success with passReqToCallback set to true', async () => {
      const res = await axios.post(`http://localhost:${port}/req`, { username: 'test', password: '1234' })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Granted')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-local',
        login: 'test',
        user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' },
        success: true,
        abortController: new AbortController()
      })
    })

    it('should call subscriber with proper arguments on failure', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { username: 'test', password: '1' })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Denied')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-local',
        login: 'test',
        user: false,
        success: false,
        abortController: new AbortController()
      })
    })

    it('should block when subscriber aborts', async () => {
      subscriberStub = sinon.spy(({ abortController }) => {
        storage('legacy').getStore().req.res.writeHead(403).end('Blocked')
        abortController.abort()
      })

      const res = await axios.post(`http://localhost:${port}/`, { username: 'test', password: '1234' })

      expect(res.status).to.equal(403)
      expect(res.data).to.equal('Blocked')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        framework: 'passport-local',
        login: 'test',
        user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' },
        success: true,
        abortController: new AbortController()
      })
    })
  })
})
