'use strict'

const { assert } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const axios = require('axios').create({ validateStatus: null })
const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')

const users = [
  {
    id: 'error_user',
    username: 'error',
    password: '1234',
    email: 'a@b.c'
  }, {
    id: 'notfound_user',
    username: 'notfound',
    password: '1234',
    email: 'a@b.c'
  }, {
    id: 'uuid_42',
    username: 'test',
    password: '1234',
    email: 'testuser@ddog.com'
  }
]

withVersions('passport', 'passport', version => {
  describe('passport instrumentation', () => {
    const passportDeserializeUserChannel = dc.channel('datadog:passport:deserializeUser:finish')
    let port, server, subscriberStub

    before(() => {
      return agent.load([], { client: false })
    })

    before((done) => {
      const express = require('../../../versions/express').get()
      const expressSession = require('../../../versions/express-session').get()
      const passport = require(`../../../versions/passport@${version}`).get()
      const LocalStrategy = require('../../../versions/passport-local').get().Strategy

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
        if (id === 'error_user') {
          return done(new Error('*MOCK* Cannot deserialize user'))
        }

        if (id === 'notfound_user') {
          return done(null, false)
        }

        const user = users.find((user) => user.id === id)

        done(null, user)
      })

      passport.use(new LocalStrategy((username, password, done) => {
        const user = users.find((user) => user.username === username && user.password === password)

        return done(null, user)
      }))

      app.get('/login', passport.authenticate('local'))

      app.get('/', (req, res) => {
        res.send(req.user?.id)
      })

      passportDeserializeUserChannel.subscribe((data) => subscriberStub(data))

      server = app.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    beforeEach(async () => {
      subscriberStub = sinon.stub()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should not call subscriber when an error occurs', async () => {
      const login = await axios.get(`http://localhost:${port}/login?username=error&password=1234`)
      const cookie = login.headers['set-cookie'][0]

      const res = await axios.get(`http://localhost:${port}/`, { headers: { cookie } })

      assert.strictEqual(res.status, 500)
      sinon.assert.notCalled(subscriberStub)
    })

    it('should not call subscriber when no user is found', async () => {
      const login = await axios.get(`http://localhost:${port}/login?username=notfound&password=1234`)
      const cookie = login.headers['set-cookie'][0]

      const res = await axios.get(`http://localhost:${port}/`, { headers: { cookie } })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.data, '')
      sinon.assert.notCalled(subscriberStub)
    })

    it('should call subscriber with proper arguments on user deserialize', async () => {
      const login = await axios.get(`http://localhost:${port}/login?username=test&password=1234`)
      const cookie = login.headers['set-cookie'][0]

      const res = await axios.get(`http://localhost:${port}/`, { headers: { cookie } })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.data, 'uuid_42')
      sinon.assert.calledOnceWithExactly(subscriberStub, {
        user: { id: 'uuid_42', username: 'test', password: '1234', email: 'testuser@ddog.com' },
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
