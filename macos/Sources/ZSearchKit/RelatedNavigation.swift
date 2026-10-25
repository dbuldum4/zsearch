/// Navigation and reply identity for the related-files view. The first search is retained even
/// when following related files from another related result. Leaving invalidates every old reply.
public struct RelatedNavigation {
    public struct Origin {
        public var response: SearchResponse?
        public var selection: ResultSelection<Int>
    }

    public private(set) var source: SearchHit?
    public private(set) var loading = false
    public private(set) var revision = 0
    private var origin: Origin?

    public init() {}

    @discardableResult
    public mutating func begin(_ source: SearchHit, response: SearchResponse?, selection: ResultSelection<Int>) -> Int {
        if self.source == nil { origin = Origin(response: response, selection: selection) }
        self.source = source
        revision += 1
        loading = true
        return revision
    }

    public func accepts(_ ticket: Int) -> Bool { source != nil && revision == ticket }

    @discardableResult
    public mutating func finish(_ ticket: Int) -> Bool {
        guard accepts(ticket) else { return false }
        loading = false
        return true
    }

    @discardableResult
    public mutating func leave() -> Origin? {
        let saved = origin
        source = nil
        loading = false
        origin = nil
        revision += 1
        return saved
    }
}
