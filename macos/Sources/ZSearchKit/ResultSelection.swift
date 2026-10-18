/// The results picked at once in the list (⌘-click, ⇧-click, ⇧↑/⇧↓, Select All), with the one
/// the preview shows (`primary`) and the one a ⇧ range starts from (`anchor`), as in Finder.
/// One result picked is the usual single selection.
public struct ResultSelection<ID: Hashable>: Equatable {
    public private(set) var ids: Set<ID> = []
    public private(set) var primary: ID?
    public private(set) var anchor: ID?

    public init(_ id: ID? = nil) {
        select(id)
    }

    public var count: Int { ids.count }

    /// Just this result, or nothing (a click, ↑/↓).
    public mutating func select(_ id: ID?) {
        ids = id.map { [$0] } ?? []
        primary = id
        anchor = id
    }

    /// Everything from the anchor to `id`, which becomes the primary.
    mutating func extend(to id: ID, in order: [ID]) {
        guard let end = order.firstIndex(of: id) else { return }
        guard let start = anchor.flatMap({ order.firstIndex(of: $0) }) else { return select(id) }
        ids = Set(order[min(start, end)...max(start, end)])
        primary = id
    }

    /// Move the primary up (-1) or down (1) and pick from the anchor to it (⇧↑/⇧↓).
    public mutating func extend(by delta: Int, in order: [ID]) {
        guard !order.isEmpty else { return }
        guard let current = primary.flatMap({ order.firstIndex(of: $0) }) else { return select(order[0]) }
        extend(to: order[min(max(current + delta, 0), order.count - 1)], in: order)
    }

    /// Every result, keeping the primary and anchor (⌘A, ⇧⌘A).
    public mutating func selectAll(in order: [ID]) {
        guard !order.isEmpty else { return }
        ids = Set(order)
        if primary.map({ !ids.contains($0) }) ?? true { primary = order[0] }
        if anchor.map({ !ids.contains($0) }) ?? true { anchor = primary }
    }

    /// Keep only the primary (Esc).
    public mutating func collapse() {
        select(primary)
    }

    /// Take a selection the list made itself (its own clicks, ⌘-clicks, ⇧-clicks and ⇧-arrows
    /// report only the new set) and work out the primary and anchor from what changed. Select All
    /// gives the same set as a ⇧-click from one end to the other, so it goes to `selectAll` instead.
    public mutating func adopt(_ new: Set<ID>, in order: [ID]) {
        guard new != ids else { return }
        guard new.count > 1 else { return select(new.first) }
        let added = new.subtracting(ids)
        ids = new
        let index = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let next: ID?
        if let primary, new.contains(primary), added.isEmpty {
            // A result other than the primary taken out.
            next = primary
        } else if !added.isEmpty {
            // A ⇧-click adds a range, which ends at the result clicked: the one farthest from its start.
            let from = (anchor ?? primary).flatMap { index[$0] } ?? 0
            next = added.max { a, b in
                let (da, db) = (abs((index[a] ?? 0) - from), abs((index[b] ?? 0) - from))
                return da != db ? da < db : (index[a] ?? 0) < (index[b] ?? 0)
            }
        } else {
            next = primary.flatMap { nearest(to: $0, in: order) } ?? order.first { new.contains($0) }
        }
        primary = next
        // A ⇧ range keeps where it started; anything else (a ⌘-click) starts a new range there.
        if let anchor, let next, new.contains(anchor), let a = index[anchor], let b = index[next], Set(order[min(a, b)...max(a, b)]) == new { return }
        anchor = next
    }

    /// The results changed (a new search, or the same one after the index changed): keep what
    /// is still listed. Results are matched by `key` (the path), as a file's id may change; an id
    /// without a key is matched as itself. With nothing left, the first result.
    public mutating func carry<Key: Hashable>(over old: [ID: Key], to new: [(id: ID, key: Key)]) {
        let byKey = Dictionary(new.map { ($0.key, $0.id) }, uniquingKeysWith: { first, _ in first })
        let present = Set(new.map(\.id))
        func moved(_ id: ID) -> ID? {
            if let key = old[id] { return byKey[key] }
            return present.contains(id) ? id : nil
        }
        let kept = Set(ids.compactMap(moved))
        guard !kept.isEmpty else { return select(new.first?.id) }
        let order = new.map(\.id)
        ids = kept
        primary = primary.flatMap(moved) ?? order.first { kept.contains($0) }
        anchor = anchor.flatMap(moved).flatMap { kept.contains($0) ? $0 : nil } ?? primary
    }

    /// Results were taken out of the list (an exclusion): drop them, as `carry` does.
    public mutating func prune(to order: [ID]) {
        carry(over: [ID: ID](), to: order.map { (id: $0, key: $0) })
    }

    /// The picked result closest to `id` in the list, looking down first.
    private func nearest(to id: ID, in order: [ID]) -> ID? {
        guard let at = order.firstIndex(of: id) else { return order.first { ids.contains($0) } }
        for distance in 1..<max(order.count, 1) {
            if at + distance < order.count, ids.contains(order[at + distance]) { return order[at + distance] }
            if at - distance >= 0, ids.contains(order[at - distance]) { return order[at - distance] }
        }
        return nil
    }
}

extension ResultSelection: Sendable where ID: Sendable {}
