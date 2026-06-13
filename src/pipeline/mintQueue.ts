// Globally serial job queue with per-key de-duplication.
//
// All on-chain writes (mint + refund) flow through one instance so they run one
// at a time — the server wallet has a single nonce sequence, and serialising
// avoids nonce races between the inline request path and the background
// scheduler. De-duplication by key (the order id) guarantees the same order is
// never processed twice concurrently: a second submit for an in-flight key
// returns the original promise instead of enqueuing again.

interface QueueItem<T> {
  key: string
  run: () => Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

export class SerialQueue {
  private readonly queue: QueueItem<unknown>[] = []
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private draining = false

  submit<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key)
    if (existing) return existing as Promise<T>

    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        key,
        run: run as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      })
    })
    this.inFlight.set(key, promise)
    void this.drain()
    return promise
  }

  /** Number of jobs queued or running — useful for graceful shutdown. */
  get size(): number {
    return this.queue.length + this.inFlight.size
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()
        if (!item) continue
        try {
          const result = await item.run()
          item.resolve(result)
        } catch (err) {
          item.reject(err)
        } finally {
          this.inFlight.delete(item.key)
        }
      }
    } finally {
      this.draining = false
    }
  }
}
