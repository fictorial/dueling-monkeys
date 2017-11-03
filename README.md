# Dueling Monkeys 🐵 🕹 🐵

A scalable backend for real-time matchplay games.

- transparent/automatic user account signup
- automatic matchmaking ("automatching")
- real-time match event relay between game clients
- rules-of-play agnostic
- match winners determined by unanimous vote
- stats per player per rules including Elo rating
- virtual coins as currency for bets
- in-app purchase receipt verification for replenishing virtual coins
- less than 400 lines of code; dive in

## Users 🙋

- a user is a human that uses a client app to talk to a Dueling Monkeys
  deployment over the Internet in order to play matches with other human users

## Matches

- a contest between 2 users
    - a user in the context of a match is a "player"
- governed by "rules of play"
- has an associated bet or wager in virtual coins
- cannot end in a tie or stalemate (at this time)
- real-time in that should finish within minutes (c.f. asynchronous play over days)
- winner earns loser's bet

## Coins 💰

- each user has a number of virtual coins
- to play a match, each player wagers or bets the same number of coins
- the winner of the match earns the loser's coins
- if a user runs out of coins, they can purchase more via in-app purchase

## Player Ratings 📈

- each user has a rating per rules of play
- the rating uses the Elo rating system

## Rules of Play 📖

- the backend does not care what rules of play govern a match
- it does bookkeeping, matchmaking, and message exchange
- it's up to the clients to manage match state based on relayed match events

## Matchmaking 🤝

- matchmaking is between random players with the same desired rules of play and
  bet amount
- this is called "automatching"
- automatching does not involve relative skill levels but is random
- direct matches are unsupported to thwart cheating
    - later: simply don't update player ratings for direct matches
- in the case where rules of play implementations change due to bug fix, etc.
    - the clients should be backwards compatible with older rules of play
      implementation versions as not all clients will upgrade their client app
      and thus two clients could have different implementations otherwise
    - after the match starts, the clients should exchange the version number of
      their rules of play implementation so that they are speaking the same
      language

## Matchplay 🌎

- once in a match, clients exchange messages through the Dueling Monkeys
  deployment
- these messages can be anything, as long as they are JSON encodable
- clients can disconnect and return (e.g. on mobile), which is called "presence"
    - there is no store-and-forward of match events
    - thus, clients will need to handle either forwarding state one to the
      other, or pausing the game when the opponent goes offline (presence)

## Refereeing, Voting 🗳

- clients are to govern the state of the match given the rules of play
- clients are only matched with others using the same rules of play
- putting clients in charge of match state could lead to cheating
    - typically, the server accepts client input and is authoritative on match
      state
- however, our clients *vote* for the winner of a match
    - only a unanimous vote causes the match to end with a normal outcome
    - a disagreement on winner causes the match to be cancelled with a
      "conflict" outcome; no rating updates; no coins won/lost
    - voting makes the backend reusable across many types of games and
      lets clients support offline play (e.g. pass and play, Bluetooth, etc.)
      without implementing rules of play logic on the client and server
    - voting this way is a mindset change vs server authoritative
        - you may of course fork this project and interpret exchanged messages
          between clients of a match should you desire server authority

## Trolls, Flagging 😈 🚩

- only a match with a normal outcome causes coins to be transferred and
  player ratings to be updated, thereby deincentivizing cheating
- trolls could just disappear if they are about to lose; this is what
  "flagging" is for.
- a client can flag the opponent in a match for any reason
    - e.g. the opponent's time offline (presence) exceeds some threshold
- this cancels the match with a "flagged" outcome
    - no ratings are updated
    - no coins are won/lost
- players flagged too many times are *quarantined*
    - a quarantined player will only automatch with other quarantined players,
      keeping the trolls away from the legit players
- since matchmaking is between random players, collusion is unlikely
    - one user controlling two clients cannot "throw" or lose on purpose to boost
      the rating of the opponent as they won't likely be automatched (given
      a big enough playerbase)
    - matchmaking via direct challenges do not update ratings or transfer coins

## Betting 💰

- betting or wagering is virtual; no real life currency
- the unit of virtual currency is the "coin"
- users are given a "signup bonus" on signup (e.g. 1000 coins)
- to play a match, both players agree on a bet amount
- we check up front that the players have enough coins to cover bets
- since we don't support more than one match per user at any time, it is fine to
  not take/debit coins up front.
    - the idea here is that we likely have mobile clients that will disappear and
      not return to finish a match. Thus, we timeout matches after some time.
    - not taking coins unless a match finishes normally means that we don't have
      a lot of tricky match state to monitor in order to issue refunds
- A debit only occurs when a match ends normally
    - we take bet coins from the losing player's account.
- A credit occurs when...
    - a match ends normally; we pay the winner; and
    - a user purchases a coin product via in-app purchase and the transaction is
      verified on the server.
- There is no "rake" or "house charge".
    - The winner of a normal-outcome match earns the coins of the loser equal to the match's bet.

## Timeouts ⏰

- pending automatches that fail to find an opponent are cancelled (e.g. 2
  minutes later)
- active matches that fail to end are cancelled (e.g. 12 hours later)
- ended matches are removed from the database a while later (e.g. 12 hours
  later)

# Tech

- Node.js
- Redis
- Socket.io

## Scalability 🤗

- Scale out server nodes; all talk to the same Redis instance
- Scale Redis server up as needed
    - You won't need more than 100 MB using this default server

# Socket.io Messages

## Client to Server 📥

    once('signup', ())

    once('checkin', (token))

    on('automatch', (rules, bet))

    on('match event', (eventType, eventData))

    on('vote for winner', (winnerId))

    on('flag opponent', (reason))

    on('get products', ())

    on('verify purchase', (productId, receipt))

    on('change display name', (newName))

## Server to Client 📤

    emit('name', userDisplayName)

    emit('coins', delta, balance, reason)

    emit('token', token)

    emit('error', context, message)

    emit('match', $match)

        $match = {
          id: string,
          rules: string,
          bet: int,

          status: string,
          outcome: string?,

          flagReason: string?,

          p1: string,
          vote1: string,
          name1: string,
          stats1: string,

          p2: string?,
          vote2: string?,
          name2: string?,
          stats2: string?,

          winnerId: string?,

          created: string,
          started: string?,
          ended: string?
        }

    emit('products', [$product])

        $product = {
          id: string,
          coins: int
        }

    emit('match event', senderId, eventType, eventData)

    emit('presence', userId, isPresent)

    emit('match started', $match)

    emit('match ended', $match)

    emit('match started', matchId)

    emit('match stats', [$stats])

    emit('server metadata', $serverMetadata)

        $serverMetadata = {
          usersOnline: int
        }

## Redis Schema 🗄

### Users 👥

    u/$userId => hash

      name    => string          Generated or user-defined non-unique display name
      coins   => int             Current balance of virtual coins
      matchId => string?         Current (only one!) match id if any

- User data does not ever expire

### Pending Matches ⏱

    pm/$rules/$bet => set of $matchId

- Members added when automatch fails to join a match and thus creates one
- Members removed when corresponding match isn't found (expired) or is joined

### Pending Matches for Quarantined Users 😷

    q/pm/$rules/$bet => set of $matchId

- Members added when automatch fails to join a match and thus creates one
- Members removed when corresponding match isn't found (expired) or is joined

### All Matches

    m/$matchId => hash

      id       => string        e.g. "01BY10N9HQ01EFGZARHE0MK4YF"
      rules    => string        rules of play
      bet      => int           > 0

      p1       => string        $userId
      name1    => string        cached $p1.name
      vote1    => string        p1 | p2

      p2       => string?       $user != p1
      name2    => string?       cached $p2.name
      vote2    => string?       $p1 | $p2

      status   => string        "pending" | "active" | "ended"
      outcome  => string?       "normal" | "conflict" | "flagged"

      created  => string        ISO-8601; e.g. "2017-11-03T13:21:59.788Z"
      started  => string?       set when status "pending" => "active"
      ended    => string?       set when status "active" => "ended"

      winnerId => string?       nil | $p1 | $p2

To be explicit, expiring a match means removing it from Redis

- Pending matches expire 2 minutes after being created
- Active matches expire 12 hours after becoming active
- Ended matches expire 12 hours after ending

### User Stats 📊

    us/$userId/$rules => hash

      elo      => int           current Elo rating (default 1200; range ~ 0-5000)
      played   => int           matches played (all-time)
      won      => int           matches won (all-time)
      winnings => int           coins earned from winning matches (all-time)

- User stats data does not ever expire

### Metadata

    metadata => hash

      sockets => int            Number of currently connected users (CCU)

# Configuration 🎛

Some elements of Dueling Monkeys are configurable via environment variables:

    PORT=3000                          Socket.io port

    REDIS_URL=redis://localhost:6379   Redis instance to use

    SECRET=foobar                      JSON Web Token signing key

    SIGNUP_BONUS=1000                  Coins to give new user on signup

    PENDING_TIMEOUT=120                Cancel pending automatches after seconds
    ACTIVE_TIMEOUT=43200               Cancel active matches after seconds
    ENDED_TIMEOUT=43200                Delete ended matches from Redis after seconds

    FLAGGED_LIMIT=20                   A player flagged this many times gets quarantined

    CLEAN_NAMES=1                      Replace profanity in usernames with '*' if 1
    MIN_NAME=3                         Min length of user display names
    MAX_NAME=32                        Max length of user display names

    REDIS_PRODUCTS_KEY=products        Where coin products JSON is stored in Redis

## Coin Products for In-App Purchases 💰

Coin products for sale are configured in Redis.  The idea is that you can update
which products are available without a new server code deployment.  The format
of the value is JSON of the form `[{"id":string, "coins":int}]`.  These are made
available to all clients regardless of platform.

# Applicability

Think Chess, Space Invaders, ".io" games... not Quake 3 😬

# License

MIT

# Copyright

Copyright (C) 2017 Fictorial LLC.
