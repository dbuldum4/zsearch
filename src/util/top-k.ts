/** Bounded min heap, keeping the best candidates while every candidate is scored. */
export class TopK<T> {
  private heap: T[] = []
  constructor(private limit: number, private score: (item: T) => number, private comparator?: (a: T, b: T) => number) {}
  private compare(a: T, b: T): number { return this.comparator ? this.comparator(a, b) : this.score(a) - this.score(b) }
  add(item: T) {
    const h = this.heap
    if (h.length < this.limit) {
      h.push(item)
      let i = h.length - 1
      while (i > 0) { const p = (i - 1) >> 1; if (this.compare(h[p]!, h[i]!) <= 0) break; [h[p], h[i]] = [h[i]!, h[p]!]; i = p }
    } else if (this.compare(item, h[0]!) > 0) {
      h[0] = item
      let i = 0
      for (;;) {
        const left = 2 * i + 1, right = left + 1
        if (left >= h.length) break
        const child = right < h.length && this.compare(h[right]!, h[left]!) < 0 ? right : left
        if (this.compare(h[i]!, h[child]!) <= 0) break
        [h[i], h[child]] = [h[child]!, h[i]!]; i = child
      }
    }
  }
  values(): T[] { return [...this.heap].sort((a, b) => this.compare(b, a)) }
}
