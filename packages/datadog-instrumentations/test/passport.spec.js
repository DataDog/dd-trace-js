'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const axios = require('axios').create({ validateStatus: null })
const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')

const users = [{
  id: 1,
  username: 'test',
  password: '1234',
  email: 'testuser@ddog.com'
}]

withVersions('passport', 'passport', version => {
  describe('passport instrumentation', () => {
    const passportDeserializeUserChannel = dc.channel('datadog:passport:deserializeUser:finish')
    let port, server, subscriberStub

    before(() => {
      return agent.load(['http', 'express', 'express-session', 'passport', 'passport-local'], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const expressSession = require('../../../versions/express-session').get()
      const passport = require(`../../../versions/passport@${version}`).get()
      const LocalStrategy = require(`../../../versions/passport-local@${version}`).get().Strategy

      const app = express()
      app.use(expressSession({
        secret: 'secret',
        resave: false,
        rolling: true,
        saveUninitialized: true
      }))

      app.use(passport.initialize())
      app.use(passport.session())

      passport.serializeUser((user, done) => {
        done(null, user.id)
      })

      passport.deserializeUser((id, done) => {
        const user = users.find((user) => user.id === id)

        done(null, user)
      })

      passport.use('local', new LocalStrategy((username, password, done) => {
        const user = users.find((user) => user.username === username && user.password === password)

        return done(null, user)
      }))

      app.get('/', passport.authenticate('local'))

      passportDeserializeUserChannel.subscribe((data) => subscriberStub(data))

      server = app.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(async () => {
      subscriberStub = sinon.stub()

      const res = await axios.post(`http://localhost:${port}/`, { username: 'test', password: '1234' })

      console.log(res.headers['set-cookie'])
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

    it('should block when subscriber aborts', async () => {
      subscriberStub = sinon.spy(({ abortController }) => {
        storage.getStore().req.res.writeHead(403).end('Blocked')
        abortController.abort()
      })


      const res = await axios.post(`http://localhost:${port}/`, { username: 'test', password: '1234' })

      expect(res.status).to.equal(403)
      expect(res.data).to.equal('Blocked')
      expect(subscriberStub).to.be.calledOnceWithExactly({
        user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' },
        abortController: new AbortController()
      })
    })
  })
})
