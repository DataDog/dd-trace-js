import 'dd-trace/init.js'
import express from 'express'
import passport from 'passport'
import { BasicStrategy } from 'passport-http'
import dc from 'dc-polyfill'

const passportVerifyChannel = dc.channel('datadog:passport:verify:finish')
let counter = 0

passportVerifyChannel.subscribe(() => {
  counter += 1
})

const app = express()

const users = [
  { id: 1, username: 'test', password: '1234' }
]

const AUTH_HEADER = `Basic ${Buffer.from('test:1234').toString('base64')}`

app.use((req, res, next) => {
  if (!req.headers.authorization) {
    req.headers.authorization = AUTH_HEADER
  }
  next()
})

passport.use('basic', new BasicStrategy({
  usernameField: 'username',
  passwordField: 'password',
  passReqToCallback: false
}, (username, password, done) => {
  const user = users.find(u => u.username === username && u.password === password)
  if (!user) {
    return done(null, false)
  }
  return done(null, user)
}))

app.use(passport.initialize())

app.get('/',
  passport.authenticate('basic', { session: false }),
  (req, res) => {
    res.setHeader('X-Counter', counter)
    res.end('authenticated\n')
  }
)

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
