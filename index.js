const sio = require('socket.io')
const ioredis = require('ioredis')
const jwt = require('jsonwebtoken')
const bandname = require('bandname')
const iap = require('in-app-purchase')
const ulid = require('ulid').ulid
const Elo = require('arpad')
const ProfanityFilter = require('bad-words')

const port = process.env.PORT || 3000
const secret = process.env.SECRET || 'foobar'
const signupBonus = Math.max(0, parseInt(process.env.SIGNUP_BONUS, 10) || 1000)
const pendingMatchTimeoutSec = Math.max(0, parseInt(process.env.PENDING_TIMEOUT, 10) || 2 * 60)
const activeMatchTimeoutSec = Math.max(0, parseInt(process.env.ACTIVE_TIMEOUT, 10) || 12 * 60 * 60)
const endedMatchTimeoutSec = Math.max(0, parseInt(process.env.ENDED_TIMEOUT, 10) || 12 * 60 * 60)
const defaultElo = Math.max(0, parseInt(process.env.DEFAULT_ELO, 10) || 1200)
const flaggedLimit = Math.max(0, parseInt(process.env.FLAGGED_LIMIT, 10) || 20)
const minDisplayNameLength = Math.max(0, parseInt(process.env.MIN_NAME, 10) || 3)
const maxDisplayNameLength = Math.max(0, parseInt(process.env.MAX_NAME, 10) || 32)
const cleanNames = parseInt(process.env.CLEAN_NAMES, 10) === 1
const productsKey = process.env.REDIS_PRODUCTS_KEY || 'products'

const profanityFilter = cleanNames ? new ProfanityFilter() : null
const redis = ioredis.createClient(process.env.REDIS_URL)
const subRedis = ioredis.createClient(process.env.REDIS_URL)

const keys = {
  user: (id) => `u/${id}`,
  match: (id) => `m/${id}`,
  pendingMatches: (rules, bet, quarantine) => `${quarantine ? 'q/' : ''}pm/${rules}/${bet}`,
  userStats: (userId, rules) => `us/${userId}/${rules}`
}

async function getUserById (id) {
  const user = await redis.hgetall(keys.user(id))
  if (user.id !== id) throw new Error('user not found')
  user.coins = parseInt(user.coins, 10)
  return user.matchId ? [user, await getMatchById(user.matchId)] : [user]
}

async function getMatchById (id) {
  const match = await redis.hgetall(keys.match(id))
  if (match.id !== id) throw new Error('match not found')
  match.bet = parseInt(match.bet, 10)
  return match
}

async function publishPresence (socket, isPresent) {
  await remoteEmit(socket.match.id, 'presence', socket.user.id, !!isPresent)
}

function finalizeMatch (pipe, match, additionalChanges) {
  const changes = Object.assign({}, additionalChanges || {}, { status: 'ended', ended: new Date() })
  Object.assign(match, changes)
  pipe.hmset(keys.match(match.id), changes)
  pipe.hdel(keys.user(match.p1), 'matchId')
  pipe.hdel(keys.user(match.p2), 'matchId')
  pipe.pexpire(keys.match(match.id), endedMatchTimeoutSec)
  remoteEmitPipe(pipe, match.id, 'match ended', match)
}

function matchWasFinalized (matchId) {
  io.in(matchId).clients((err, clients) => {
    if (!err) {
      for (const client of clients) {
        client.leave(matchId)
        client.match = null
      }
    }
  })

  subRedis.unsubscribe(matchId)
}

function remoteEmitPipe (pipe, matchId, type, ...args) {
  pipe.publish(matchId, JSON.stringify([type, ...args]))
}

async function remoteEmit (matchId, type, ...args) {
  await redis.publish(matchId, JSON.stringify([type, ...args]))
}

// from remoteEmit* on another node to this node; we forward to local room for given match.

subRedis.on('message', (channel, message) => {
  try {
    const args = JSON.parse(message)
    const nsp = io.to(channel)
    nsp.emit.apply(nsp, args)
    if (args[0] === 'match ended') matchWasFinalized(channel)
  } catch (error) {}
})

function addHandler (socket, event, { noUser, user, noMatch, match, status, once }, callback) {
  socket[once === true ? 'once' : 'on'](event, async (...args) => {
    try {
      if (noUser === true && socket.user) throw new Error('already authenticated')
      if (user === true && !socket.user) throw new Error('authentication required')
      if (noMatch === true && socket.match) throw new Error('user is in a match')
      if (match === true && !socket.match) throw new Error('user is not in a match')
      if (status !== undefined && socket.match.status !== status) throw new Error(`match status is not ${status}`)
      callback.call(socket, ...args)
    } catch (error) {
      socket.emit('error', event, error.message)
    }
  })
}

const serverMetadata = {
  usersOnline: 0
}

async function onSignup () {
  const name = bandname()

  this.user = {
    id: ulid(),
    name: name.substr(0, maxDisplayNameLength),
    coins: signupBonus
  }

  await redis.hmset(keys.user(this.user.id), {
    name: this.user.name,
    coins: this.user.coins
  })

  this.emit('name', this.user.name)
  this.emit('coins', signupBonus, signupBonus, 'signup bonus')
  this.emit('token', jwt.sign({ id: this.user.id }, secret))
  this.emit('server metadata', serverMetadata)
}

async function onCheckin (token) {
  try {
    var {id} = jwt.verify(token, secret)
  } catch (error) {
    throw new Error('invalid token')
  }

  const [user, match] = await getUserById(id)
  this.user = user
  this.user.id = id
  this.emit('name', user.name)
  this.emit('coins', 0, user.coins, 'current balance')

  if (match) {
    this.emit('match', match)

    if (match.status !== 'ended') {
      this.match = match
      await publishPresence(this, true)
      this.join(match.id)
      subRedis.subscribe(match.id)
    }
  }

  this.emit('server metadata', serverMetadata)
}

async function joinPendingMatch (rules, bet, pendingMatchesKey) {
  const stats = await getUserStats(this.user.id, rules)

  for (const matchId of await redis.srandmember(pendingMatchesKey, 100)) {
    const matchKey = keys.match(matchId)
    const {p1, status} = await redis.hmget(matchKey, 'p1', 'status')

    if (status === undefined) {    // expired pending match
      await redis.srem(pendingMatchesKey, matchId)
      continue
    }

    if (status !== 'pending' && p1 !== this.user.id) {
      if (await redis.hsetnx(matchKey, 'p2', this.user.id)) {
        const pipe = redis.pipeline()
        pipe.hset(keys.user(this.user.id), 'matchId', matchId)
        pipe.srem(pendingMatchesKey, matchId)
        pipe.persist(matchKey)
        pipe.hmset(matchKey, {
          status: 'active',
          name2: this.user.name,
          stats2: JSON.stringify(stats),
          started: new Date()
        })
        pipe.pexpire(matchKey, activeMatchTimeoutSec)
        remoteEmitPipe(pipe, matchId, 'user joined', this.user.id, this.user.name, stats)
        remoteEmitPipe(pipe, matchId, 'match started', await getMatchById(matchId))
        await pipe.exec()

        return getMatchById(matchId)
      }
    }
  }
}

async function createPendingMatch (rules, bet, pendingMatchesKey) {
  const match = {
    id: ulid(),
    rules,
    bet,
    p1: this.user.id,
    name1: this.user.name,
    stats1: JSON.stringify(await getUserStats(this.user.id, rules)),
    created: new Date(),
    status: 'pending'
  }

  await redis.pipeline()
    .hmset(keys.match(match.id), match)
    .pexpire(keys.match(match.id), pendingMatchTimeoutSec)
    .sadd(pendingMatchesKey, match.id)
    .hset(keys.user(this.user.id), 'matchId', match.id)
    .exec()

  return match
}

async function onAutomatch (rules, bet) {
  bet = parseInt(bet, 10)
  if (isNaN(bet) || bet <= 0) throw new Error('invalid bet')

  const bal = parseInt(await redis.hget(keys.user(this.user.id), 'coins'), 10)
  if (bal < bet) throw new Error('out of coins')

  const didSet = await redis.hsetnx(keys.user(this.user.id), 'matchId', -1)
  if (!didSet) throw new Error('user has a match')

  const flaggedCount = parseInt(await redis.hget(keys.user(this.user.id), 'flagged'), 10) || 0
  const quarantine = flaggedCount > flaggedLimit
  const pendingMatchesKey = keys.pendingMatches(rules, bet, quarantine)

  const match = (
    await joinPendingMatch.call(this, rules, bet, pendingMatchesKey) ||
    await createPendingMatch.call(this, rules, bet, pendingMatchesKey))

  this.match = match
  this.emit('match', match)
  this.join(match.id)
  subRedis.subscribe(match.id)
}

async function onMatchEvent (eventType, eventData) {
  await remoteEmit(this.match.id, 'match event', this.user.id, eventType, eventData)
}

async function getUserStats (userId, rules) {
  return convertStats(await redis.hgetall(keys.userStats(userId, rules)))
}

function convertStats (stats) {
  return {
    elo: parseInt(stats.elo, 10) || defaultElo,
    played: parseInt(stats.played, 10) || 0,
    won: parseInt(stats.won, 10) || 0,
    winnings: parseInt(stats.winnings, 10) || 0
  }
}

function assertIsPlayer (match, userId) {
  if (userId === match.p1) return 1
  if (userId === match.p2) return 2
  throw new Error('user is not player')
}

function getVoteSubKeys (match, voterId) {
  let playerNo = assertIsPlayer(match, voterId)
  let voteSubKey = `vote${playerNo}`
  let opponentPlayerNo = playerNo === 1 ? 2 : 1
  let opponentVoteSubKey = `vote${opponentPlayerNo}`
  return [voteSubKey, opponentVoteSubKey]
}

async function onVote (winnerId) {
  assertIsPlayer(this.match, winnerId)

  const [voteSubKey, opponentVoteSubKey] = getVoteSubKeys(this.match, this.user.id)

  const didSet = await redis.hsetnx(keys.match(this.match.id), voteSubKey, winnerId)
  if (!didSet) throw new Error('already voted')

  const opponentWinnerId = await redis.hget(keys.match(this.match.id), opponentVoteSubKey)
  if (opponentWinnerId) {
    const pipe = redis.pipeline()

    if (opponentWinnerId !== winnerId) {
      finalizeMatch(pipe, this.match, { outcome: 'conflict' })
    } else {
      updatePlayersPostMatch(this.match, pipe)
      finalizeMatch(pipe, this.match, { outcome: 'normal', winnerId })
    }

    await pipe.exec()
  }
}

function opponentOf (match, userId) {
  return userId === this.match.p1 ? this.match.p2 : this.match.p1
}

async function updatePlayersPostMatch (match, pipe) {
  const loserId = opponentOf(match, match.winnerId)
  const winnerStats = await getUserStats(match.winnerId, this.match.rules)
  const loserStats = await getUserStats(loserId, this.match.rules)

  const elo = new Elo()
  const newWinnerElo = elo.newRatingIfWon(winnerStats.elo, loserStats.elo)
  const newLoserElo = elo.newRatingIfWon(loserStats.elo, winnerStats.elo)

  winnerStats.elo = newWinnerElo
  winnerStats.played++
  winnerStats.won++
  winnerStats.winnings += match.bet

  loserStats.elo = newLoserElo
  loserStats.played++

  pipe.hincrby(keys.user(match.winnerId), 'coins', this.match.bet)
  pipe.hincrby(keys.user(loserId), 'coins', -this.match.bet)
  pipe.hmset(keys.userStats(match.winnerId, this.match.rules), winnerStats)
  pipe.hmset(keys.userStats(loserId, this.match.rules), loserStats)

  winnerStats.userId = match.winnerId
  loserStats.userId = loserId
  remoteEmitPipe(pipe, this.match.id, 'match stats', winnerStats, loserStats)
}

async function onFlagOpponent (reason) {
  const pipe = redis.pipeline()
  finalizeMatch(pipe, this.match, { outcome: 'flagged', flagReason: reason })
  pipe.hincrby(keys.user(opponentOf(this.match, this.user.id)), 'flagged', 1)
  await pipe.exec()
}

async function loadProducts () {
  return JSON.parse(await redis.get(productsKey))
}

async function onGetProducts () {
  this.emit('products', await loadProducts())
}

async function onVerifyPurchase (productId, receipt) {
  const product = (await loadProducts()).find(product => product.id === productId)
  if (!product) throw new Error('unknown product')

  await iap.setup()
  if (iap.isValidated(await iap.validate(receipt))) {
    const bal = await redis.hincrby(keys.user(this.user.id), 'coins', product.coins)
    this.emit('coins', product.coins, bal, 'purchase verified')
  } else {
    throw new Error('invalid receipt')
  }
}

async function onChangeDisplayName (newName) {
  newName = (newName || '').trim()
  if (minDisplayNameLength > 0 && newName.length < minDisplayNameLength) throw new Error('name too short')
  if (maxDisplayNameLength > 0 && newName.length > maxDisplayNameLength) throw new Error('name too long')
  if (cleanNames) newName = profanityFilter.clean(newName)
  redis.set(keys.user(this.user.id), 'name', newName)
  this.user.name = newName
  this.emit('name', this.user.name)
}

async function onDisconnect () {
  serverMetadata.usersOnline = await redis.hincrby('metadata', 'sockets', -1)

  if (this.user && this.match) {
    await publishPresence(this, false)

    io.in(this.match.id).clients((err, clients) => {
      if (!err && clients.length === 0) subRedis.unsubscribe(this.match.id)
    })
  }
}

const io = sio(port)
io.on('connection', async (socket) => {
  serverMetadata.usersOnline = await redis.hincrby('metadata', 'sockets', 1)
  addHandler(socket, 'signup', { noUser: true, once: true }, onSignup)
  addHandler(socket, 'checkin', { noUser: true, once: true }, onCheckin)
  addHandler(socket, 'automatch', { user: true, noMatch: true }, onAutomatch)
  addHandler(socket, 'match event', { user: true, match: true }, onMatchEvent)
  addHandler(socket, 'vote for winner', { user: true, match: true, status: 'active' }, onVote)
  addHandler(socket, 'flag opponent', { user: true, match: true, status: 'active' }, onFlagOpponent)
  addHandler(socket, 'get products', { user: true }, onGetProducts)
  addHandler(socket, 'verify purchase', { user: true }, onVerifyPurchase)
  addHandler(socket, 'change display name', { user: true }, onChangeDisplayName)
  socket.on('disconnect', onDisconnect.bind(socket))
})
