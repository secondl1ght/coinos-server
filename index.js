import axios from 'axios'
import bcrypt from 'bcrypt'
import bitcoin from 'bitcoinjs-lib'
import bodyParser from 'body-parser'
import bolt11 from 'bolt11'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import core from 'bitcoin-core'
import cors from 'cors'
import crypto from 'crypto-js'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'fs'
import grpc from 'grpc'
import io from 'socket.io'
import jwt from 'jsonwebtoken'
import morgan from 'morgan'
import reverse from 'buffer-reverse'
import zmq from 'zmq'

import config from './config'

import graphqlHTTP from 'express-graphql'

dotenv.config()
const l = console.log

;(async () => {
  const ln = async ({ server, tls, macaroon, channelpeers }) => {
    const ln = await require('lnrpc')({ server, tls })
    ln.meta = new grpc.Metadata()
    ln.meta.add('macaroon', fs.readFileSync(macaroon).toString('hex'))
    ln.channelpeers = channelpeers
    return ln
  }

  const lna = await ln(config.lna)
  const lnb = await ln(config.lnb)

  const bc = new core(config.bitcoin)

  const app = express()
  app.enable('trust proxy')
  app.use(bodyParser.urlencoded({ extended: true }))
  app.use(bodyParser.json())
  app.use(cookieParser())
  app.use(cors({ credentials: true, origin: 'http://*:*' }))
  app.use(compression())
  app.use(morgan('combined'))

  const server = require('http').Server(app)
  const socket = io(server, { origins: '*:*' })
  const db = await require('./db')(lna)
  const passport = require('./passport')(db)
  const auth = passport.authenticate('jwt', { session: false })
  const sids = {}
  const seen = []

  app.use(passport.initialize())

  app.use('/graphql', auth, graphqlHTTP({
    schema: db.gqlschema,
    graphiql: true
  }))

  socket.use((socket, next) => {
    try {
      let token = socket.request.headers.cookie.match(`token=([^;]+)`)[1]
      let user = jwt.decode(token).username
      socket.request.user = user
      sids[user] = socket.id
    } catch (e) { return }
    next()
  })

  socket.sockets.on('connect', socket => {
    socket.emit('success', {
      message: 'success logged in!',
      user: socket.request.user
    })
  })

  const handlePayment = async msg => {
    let payment = await db.Payment.findOne({
      include: { model: db.User, as: 'user' },
      where: {
        hash: msg.payment_request
      }
    })

    if (!payment) return

    payment.received = true
    payment.user.channelbalance += parseInt(msg.value)

    await payment.save()
    await payment.user.save()
    payments.push(msg.payment_request)
 
    socket.to(sids[payment.user.username]).emit('invoice', msg)
  } 

  const invoices = lna.subscribeInvoices({})
  invoices.on('data', handlePayment)

  const invoicesb = lnb.subscribeInvoices({})
  invoicesb.on('data', handlePayment)

  const zmqSock = zmq.socket('sub')
  zmqSock.connect(config.bitcoin.zmq)
  zmqSock.subscribe('rawblock')
  zmqSock.subscribe('rawtx')

  const addresses = {}
  await db.User.findAll({
    attributes: ['username', 'address'],
  }).map(u => { addresses[u.address] = u.username })

  const payments = (await db.Payment.findAll({ 
    attributes: ['hash']
  })).map(p => p.hash)

  zmqSock.on('message', async (topic, message, sequence) => {
    topic = topic.toString('utf8')
    message = message.toString('hex')

    switch (topic) {
      case 'rawtx': {
        let tx = bitcoin.Transaction.fromHex(message)
        let hash = reverse(tx.getHash()).toString('hex')
        if (payments.includes(hash)) return
        let total = tx.outs.reduce((a, b) => a + b.value, 0)
        tx.outs.map(async o => {
          try {
            let network = config.bitcoin.network
            if (network === 'mainnet') {
              network = 'bitcoin'
            } 

            let address = bitcoin.address.fromOutputScript(
              o.script, 
              bitcoin.networks[network],
            )

            if (Object.keys(addresses).includes(address)) {
              payments.push(hash)

              let user = await db.User.findOne({
                where: {
                  username: addresses[address],
                }
              })

              user.balance += o.value
              await user.save()
              
              await db.Payment.create({
                user_id: user.id,
                hash: hash,
                amount: o.value,
                currency: 'CAD',
                rate: app.get('rates').ask,
              })

              socket.emit('tx', message)
            } 
          } catch(e) {}
        })

        break
      } 

      case 'rawblock': {
        let block = bitcoin.Block.fromHex(message)
        l('block', block.getHash().toString('hex'))
        break
      } 
    }
  })

  app.post('/register', async (req, res) => {
    let err = m => res.status(500).send(m)
    let user = req.body
    if (!user.username) return err('Username required')
    if (user.password.length < 2) return err('Password too short')

    let exists = await db.User.count({ where: { username: user.username } })
    if (exists) return err('Username taken')

    user.address = (await lna.newAddress({ type: 1 }, lna.meta)).address
    user.password = await bcrypt.hash(user.password, 1)
    addresses[user.address] = user.username
    res.send(await db.User.create(user))
  })

  app.post('/user', async (req, res) => {
    await db['User'].update(user, { where: { username: user.username } })
  })

  app.post('/openchannel', auth, async (req, res) => {
    let err = m => res.status(500).send(m)
    if (req.user.balance < 10000) return err('Need at least 10000 satoshis for channel opening')

    let pending = await lna.pendingChannels({}, lna.meta)
    let busypeers = pending.pending_open_channels.map(c => c.channel.remote_node_pub)
    let peer = lna.channelpeers.find(p => !busypeers.includes(p))
    let sent = false

    l('channeling')
    
    if (!peer) {
      res.status(500).send('All peers have pending channel requests, try again later')
      return
    }
    
    try {
      let amount = Math.min(req.user.balance, 16777216)
      
      let openchannel = async (peer, amount) => {
        let channel = await lna.openChannel({
          node_pubkey: new Buffer(peer, 'hex'),
          local_funding_amount: amount,
        })
        
        channel.on('data', async data => {
          if (sent || !data.chan_pending) return
          req.user.channelbalance += amount
          req.user.balance -= amount
          req.user.channel = reverse(data.chan_pending.txid).toString('hex')
          await req.user.save()
          res.send(data)
          sent = true
        })

        channel.on('error', err => {
          l('channel error', peer, err)
          if (err.message.startsWith('Multiple')) {
            busypeers.push(peer)
            peer = lna.channelpeers.find(p => !busypeers.includes(p))
            return openchannel(peer, amount)
          } 

          return res.status(500).send(err.message)
        })
      }

      openchannel(peer, amount)
    } catch (err) {
      l('rpc error', peer, err)
      return res.status(500).send(err)
    } 
  })

  app.post('/closechannels', auth, async (req, res) => {
    req.user.balance += req.user.channelbalance
    req.user.channelbalance = 0
    await req.user.save()
    res.send(req.user)
  })


  app.post('/faucet', auth, async (req, res) => {
    return res.send('not for mainnet')
    // await bc.walletPassphrase('kek', 30000)
    // await bc.sendToAddress(req.user.address, 0.001)
    // res.send('success')
  })

  app.post('/sendPayment', auth, async (req, res) => {
    await req.user.reload()
    let hash = req.body.payreq
    let payreq = bolt11.decode(hash)

    if (seen.includes(hash)) {
      return res.status(500).send('Invoice has been paid, can\'t pay again')
    } 

    if (req.user.channelbalance < payreq.satoshis) {
      return res.status(500).send('Not enough satoshis')
    } 
    
    const stream = lna.sendPayment(lna.meta, {})
    stream.write({ payment_request: req.body.payreq })

    stream.on('data', async m => {
      if (m.payment_error) {
        res.status(500).send(m.payment_error)
      } else {
        if (seen.includes(m.payment_preimage)) return
        seen.push(m.payment_preimage)

        let total = parseInt(m.payment_route.total_amt) + parseInt(m.payment_route.total_fees)
        req.user.channelbalance -= total

        await db.Payment.create({
          amount: -total,
          user_id: req.user.id,
          hash,
          rate: app.get('rates').ask,
          currency: 'CAD',
        })

        await req.user.save()
        seen.push(hash)
        res.send(m)
      }
    })

    stream.on('error', e => {
      res.status(500).send(e.message)
    })
  }) 

  app.post('/sendCoins', auth, async (req, res) => {
    await req.user.reload()
    const MINFEE = 180

    let { address, amount } = req.body

    if (amount === req.user.balance) {
      amount = req.user.balance - MINFEE
    } 

    if (req.user.balance < amount - MINFEE) {
      res.status(500).send('Not enough funds')
      return
    }

    try {
      let txid = (await lna.sendCoins({ addr: address, amount })).txid
      let txhex = await bc.getRawTransaction(txid)
      let tx = bitcoin.Transaction.fromHex(txhex)

      let input_total = await tx.ins.reduce(async (a, input) => {
        let h = await bc.getRawTransaction(reverse(input.hash).toString('hex'))
        return a + bitcoin.Transaction.fromHex(h).outs[input.index].value
      }, 0)
      let output_total = tx.outs.reduce((a, b) => a + b.value, 0)

      let fees = input_total - output_total
      let total = Math.min(parseInt(amount) + fees, req.user.balance)
      req.user.balance -= total
      await req.user.save()

      await db.Payment.create({
        amount: -total,
        user_id: req.user.id,
        hash: txid,
        rate: app.get('rates').ask,
        currency: 'CAD',
      })

      res.send({ txid, tx, amount, fees })
    } catch (e) {
      l(e)
      res.status(500).send(e.message)
    } 
  }) 

  app.post('/addInvoice', auth, async (req, res) => {
    let invoice = await lnb.addInvoice({ value: req.body.amount })
    
    await db.Payment.create({
      user_id: req.user.id,
      hash: invoice.payment_request,
      amount: req.body.amount,
      currency: 'CAD',
      rate: app.get('rates').ask,
      tip: req.body.tip,
    })

    res.send(invoice)
  })

  let fetchRates
  (fetchRates = async () => {
    const nonce = Date.now().toString()
    const conf = config.quad
    const signature = crypto.HmacSHA256(
      nonce + conf.client_id + conf.key, 
      conf.secret
    ).toString()

    try {
      let res = await axios.get('https://api.quadrigacx.com/v2/order_book')
      let ask = res.data.asks[0][0]
      l('quadriga ask price: ', ask)
      app.set('rates', { ask })
    } catch (e) { l(e) }

    setTimeout(fetchRates, 150000)
  })()

  app.get('/rates', (req, res) => {
    res.send(app.get('rates'))
  })

  app.post('/login', async (req, res) => {
    try {
      let user = await db.User.findOne({
        where: {
          username: req.body.username
        } 
      })

      if (!user) throw new Error('User not found')

      let result = await bcrypt.compare(req.body.password, user.password)
      if (result) {
        let payload = { username: user.username }
        let token = jwt.sign(payload, process.env.SECRET)
        res.cookie('token', token, { expires: new Date(Date.now() + 432000000) })
        res.send({ user, token })
      } else {
        res.status(401).end()
      }
    } catch(err) {
      l(err)
      res.status(401).end()
    }
  })

  app.use(function (err, req, res, next) {
    res.status(500)
    res.send('An error occurred')
    l(err.stack)
    return res.end()
  })

  server.listen(3000)
})()
