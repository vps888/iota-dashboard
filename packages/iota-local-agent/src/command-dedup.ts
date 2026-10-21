export function commandCooldownMs(command: string): number {
  return command === 'restart' ? 60_000 : 20_000
}

// Delivery identity is distinct from short-lived command throttling. Feishu can
// redeliver the same event minutes later; it must not execute a second time.
export class CommandDeliveryDedup {
  private seen = new Map<string, number>()
  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}
  claim(chatId: string, source: string, messageId: string, eventId: string | undefined, now = Date.now()): boolean {
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key)
    // Card message IDs identify the card, not a click. Distinct click events
    // on the same card must remain actionable.
    const keys = [eventId ? `${chatId}:event:${eventId}` : '',
      source === 'message' && messageId ? `${chatId}:message:${messageId}` : ''].filter(Boolean)
    if (keys.some(key => this.seen.has(key))) return false
    for (const key of keys) this.seen.set(key, now + this.ttlMs)
    return true
  }
}
