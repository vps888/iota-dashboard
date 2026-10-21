import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandDeliveryDedup, commandCooldownMs } from '../dist/command-dedup.js'

test('same message/event redelivered two minutes later is ignored', () => {
  const dedup = new CommandDeliveryDedup()
  assert.equal(dedup.claim('chat', 'message', 'message1', 'event1', 0), true)
  assert.equal(dedup.claim('chat', 'message', 'message1', 'event1', 125000), false)
  assert.equal(dedup.claim('chat', 'message', 'message1', 'new-event', 130000), false)
  assert.equal(dedup.claim('chat', 'message', 'new-message', 'event1', 140000), false)
  assert.equal(dedup.claim('chat', 'message', 'message2', 'event2', 150000), true)
})
test('distinct card clicks remain usable and duplicate clicks are ignored', () => {
  const dedup = new CommandDeliveryDedup()
  assert.equal(dedup.claim('chat', 'card', 'card1', 'click1', 0), true)
  assert.equal(dedup.claim('chat', 'card', 'card1', 'click1', 125000), false)
  assert.equal(dedup.claim('chat', 'card', 'card1', 'click2', 130000), true)
})
test('message identity works without event ID, with chat isolation and expiry', () => {
  const dedup = new CommandDeliveryDedup(1000)
  assert.equal(dedup.claim('a', 'message', 'm', undefined, 0), true)
  assert.equal(dedup.claim('a', 'message', 'm', undefined, 900), false)
  assert.equal(dedup.claim('b', 'message', 'm', undefined, 900), true)
  assert.equal(dedup.claim('a', 'message', 'm', undefined, 1000), true)
})

 test('status and earnings have a 20-second window while restart retains 60 seconds', () => {
  assert.equal(commandCooldownMs('status'), 20_000)
  assert.equal(commandCooldownMs('earnings'), 20_000)
  assert.equal(commandCooldownMs('restart'), 60_000)
})
