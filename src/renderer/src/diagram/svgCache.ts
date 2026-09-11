// The rendered-SVG cache behind `render.ts`.
//
// A rendered diagram is not a small string: `exportToSvg` embeds the subset of
// every font the scene uses as base64 inside the markup, so one tile can be a
// megabyte or more. The first version of this cache held 40 of them and evicted
// in insertion order — which is neither a byte bound (40 fat diagrams is ~40 MB
// of live strings) nor an LRU (the entry evicted was the oldest *inserted*, so
// the tile you keep scrolling back to is the one that keeps getting thrown
// away and re-rendered).
//
// So: bounded by total markup size, evicting least-recently-USED, with a count
// bound kept as a cheap secondary guard. `.length` is UTF-16 units rather than
// bytes, which for base64-and-tags markup is within a rounding error of both
// the byte count and what the string actually costs in the heap.
//
// Pure (a Map and two numbers), so it is unit-tested without Excalidraw.

export class SvgCache {
  private readonly entries = new Map<string, string>()
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number,
  ) {}

  /** A hit also marks the entry most-recently-used (Map iterates in insertion order). */
  get(key: string): string | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  set(key: string, markup: string): void {
    const prev = this.entries.get(key)
    if (prev !== undefined) {
      this.total -= prev.length
      this.entries.delete(key)
    }
    this.entries.set(key, markup)
    this.total += markup.length
    // Never evict the entry that was just asked for, even if it alone is over
    // the bound: the caller is about to render it, and dropping it would only
    // guarantee a re-render on the next scroll.
    while ((this.total > this.maxBytes || this.entries.size > this.maxEntries) && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.total -= this.entries.get(oldest)?.length ?? 0
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }

  /** Live total of the cached markup, in UTF-16 units. */
  get bytes(): number {
    return this.total
  }

  clear(): void {
    this.entries.clear()
    this.total = 0
  }
}
