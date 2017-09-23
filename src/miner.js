const {spawn} = require('threads')
const bus = require('./bus')
const {calculateHash, createBlock} = require('./lib/block')
const co = require('co')
const store = require('./store')
const {BlockError, TransactionError} = require('./errors')
const config = require('./config')

/**
 * Start mining
 */
function mine () {
  if (! store.mining) return

  co(function* () {
    while (store.mining) {
      const block = yield mineBlock(store.mempool, store.lastBlock(), store.difficulty, store.wallet.public)
      if (! block) {
        // Someone mined block first, started mining new one
        continue
      }
      try {
        store.addBlock(block)
        bus.emit('block-added-by-me', block)
        bus.emit('balance-updated', {
          address: store.wallet.public,
          balance: store.getBalanceForAddress(store.wallet.public),
        })
      } catch (e) {
        if (! e instanceof BlockError && ! e instanceof TransactionError) throw e
        console.error(e)
      }
    }
  }).catch(e => console.error(e))
}

/**
 * Mine a block in separate process
 *
 * @param transactions Transactions list to add to the block
 * @param lastBlock Last block in the blockchain
 * @param difficulty Current difficulty
 * @param address Addres for reward transaction
 * @return {*}
 */
function mineBlock (transactions, lastBlock, difficulty, address) {
  const block = createBlock(transactions, lastBlock, address)
  block.hash = calculateHash(block)

  console.log(`Started mining block ${block.index}`)

  return new Promise((resolve, reject) => {
    if (config.demoMode) {
      setTimeout(() => findBlockHash(block, difficulty).then(block => resolve(block)), 60 * 1000)
    } else {
      findBlockHash(block, difficulty).then(block => resolve(block))
    }
  })
}

/**
 * Find block hash according to difficulty
 *
 * @param block
 * @param difficulty
 * @return {Promise}
 */
function findBlockHash (block, difficulty) {
  return new Promise((resolve, reject) => {
    const mineStop = () => {
      removeListeners()
      resolve(null)
      console.log('kill thread')
      thread.kill()
    }
    // Listeners for stopping mining
    const blockAddedListener = b => {if (b.index >= block.index) mineStop()}
    const mineStopListener = b => mineStop
    const removeListeners = () => {
      bus.removeListener('block-added', blockAddedListener)
      bus.removeListener('mine-stop', mineStopListener)
    }
    // If other process found the same block faster, kill current one
    bus.once('block-added', blockAddedListener)
    bus.once('mine-stop', mineStopListener)

    // Use separate thread to not to block main thread
    const thread = spawn(function ({block, difficulty, __dirname}, done, progress) {
      const util = require(__dirname + '/lib/block')
      while (util.getDifficulty(block.hash) >= difficulty) {
        block.nonce ++
        block.hash = util.calculateHash(block)
        if (block.nonce % 100000 === 0) progress('100K hashes')
      }
      done(block)
    })
      .send({block, difficulty, __dirname})
      .on('progress', progress => console.log(progress))
      .on('message', block => {
        removeListeners()
        resolve(block)
      })
  })
}


module.exports = {mine, mineBlock}
