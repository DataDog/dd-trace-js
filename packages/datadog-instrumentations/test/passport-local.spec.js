'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const getPort = require('get-port')
const axios = require('axios')
const dc = require('dc-polyfill')

withVersions('passport-local', 'passport-local', version => {
  describe('passport-local instrumentation', () => {
    const passportVerifyChannel = dc.channel('datadog:passport:verify:finish')
    let port, server, subscriberStub

    before(() => {
      return agent.load(['express', 'passport', 'passport-local'], { client: false })
    })
    before((done) => {
      const express = require('../../../versions/express').get()
      const passport = require(`../../../versions/passport`).get()
      const LocalStrategy = require(`../../../versions/passport-local@${version}`).get().Strategy
      const app = express()

      passport.use(new LocalStrategy({ usernameField: 'username', passwordField: 'password' },
        (username, password, done) => {
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
      ))

      app.use(passport.initialize())
      app.use(express.json())

      app.post('/',
        passport.authenticate('local', {
          successRedirect: '/grant',
          failureRedirect: '/deny',
          passReqToCallback: false,
          session: false
        })
      )

      app.post('/req',
        passport.authenticate('local', {
          successRedirect: '/grant',
          failureRedirect: '/deny',
          passReqToCallback: true,
          session: false
        })
      )

      app.get('/grant', (req, res) => {
        res.send('Granted')
      })

      app.get('/deny', (req, res) => {
        res.send('Denied')
      })

      passportVerifyChannel.subscribe(function ({ credentials, user, err, info }) {
        subscriberStub(arguments[0])
      })

      getPort().then(newPort => {
        port = newPort
        server = app.listen(port, () => {
          done()
        })
      })
    })
    beforeEach(() => {
      subscriberStub = sinon.stub()
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('should call subscriber with proper arguments on success', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { username: 'test', password: '1234' })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Granted')
      expect(subscriberStub).to.be.calledOnceWithExactly(
        {
          credentials: { type: 'local', username: 'test' },
          user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' }
        }
      )
    })

    it('should call subscriber with proper arguments on success with passReqToCallback set to true', async () => {
      const res = await axios.post(`http://localhost:${port}/req`, { username: 'test', password: '1234' })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Granted')
      expect(subscriberStub).to.be.calledOnceWithExactly(
        {
          credentials: { type: 'local', username: 'test' },
          user: { _id: 1, username: 'test', password: '1234', email: 'testuser@ddog.com' }
        }
      )
    })

    it('should call subscriber with proper arguments on failure', async () => {
      const res = await axios.post(`http://localhost:${port}/`, { username: 'test', password: '1' })

      expect(res.status).to.equal(200)
      expect(res.data).to.equal('Denied')
      expect(subscriberStub).to.be.calledOnceWithExactly(
        {
          credentials: { type: 'local', username: 'test' },
          user: false
        }
      )
    })
  })
})
