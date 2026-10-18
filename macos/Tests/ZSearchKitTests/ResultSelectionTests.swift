import XCTest
@testable import ZSearchKit

final class ResultSelectionTests: XCTestCase {
    private let order = [10, 11, 12, 13, 14, 15]

    func testSelectAndToggle() {
        var s = ResultSelection(11)
        XCTAssertEqual(s.ids, [11])
        XCTAssertEqual(s.primary, 11)
        s.toggle(13, in: order)
        XCTAssertEqual(s.ids, [11, 13])
        XCTAssertEqual(s.primary, 13)
        XCTAssertEqual(s.anchor, 13)
        s.toggle(14, in: order)
        // Taking out the primary moves it to the nearest picked result, looking down first.
        s.toggle(14, in: order)
        XCTAssertEqual(s.primary, 13)
        s.toggle(13, in: order)
        XCTAssertEqual(s.ids, [11])
        XCTAssertEqual(s.primary, 11)
        s.toggle(11, in: order)
        XCTAssertEqual(s.ids, [])
        XCTAssertNil(s.primary)
        s.select(nil)
        XCTAssertEqual(s, ResultSelection<Int>())
    }

    func testRangeFromAnchor() {
        var s = ResultSelection(12)
        s.extend(to: 14, in: order)
        XCTAssertEqual(s.ordered(in: order), [12, 13, 14])
        XCTAssertEqual(s.primary, 14)
        XCTAssertEqual(s.anchor, 12)
        // A second ⇧-click replaces the range, from the same anchor.
        s.extend(to: 10, in: order)
        XCTAssertEqual(s.ordered(in: order), [10, 11, 12])
        XCTAssertEqual(s.primary, 10)
        // ⌘-click moves the anchor.
        s.toggle(15, in: order)
        s.extend(to: 13, in: order)
        XCTAssertEqual(s.ordered(in: order), [13, 14, 15])
        s.extend(to: 99, in: order)
        XCTAssertEqual(s.ordered(in: order), [13, 14, 15])
    }

    func testShiftArrows() {
        var s = ResultSelection(12)
        s.extend(by: 1, in: order)
        s.extend(by: 1, in: order)
        XCTAssertEqual(s.ordered(in: order), [12, 13, 14])
        XCTAssertEqual(s.primary, 14)
        s.extend(by: -1, in: order)
        XCTAssertEqual(s.ordered(in: order), [12, 13])
        s.extend(by: -3, in: order)
        XCTAssertEqual(s.ordered(in: order), [10, 11, 12])
        XCTAssertEqual(s.primary, 10)
        s.extend(by: -1, in: order)
        XCTAssertEqual(s.ordered(in: order), [10, 11, 12])
        var empty = ResultSelection<Int>()
        empty.extend(by: 1, in: order)
        XCTAssertEqual(empty.ids, [10])
        empty.extend(by: 1, in: [])
        XCTAssertEqual(empty.ids, [10])
    }

    func testSelectAllAndCollapse() {
        var s = ResultSelection(13)
        s.selectAll(in: order)
        XCTAssertEqual(s.ids, Set(order))
        XCTAssertEqual(s.primary, 13)
        s.collapse()
        XCTAssertEqual(s.ids, [13])
        XCTAssertEqual(s.anchor, 13)
        var none = ResultSelection<Int>()
        none.selectAll(in: order)
        XCTAssertEqual(none.primary, 10)
        none.selectAll(in: [])
        XCTAssertEqual(none.count, 6)
    }

    func testAdoptsTheListsOwnSelection() {
        var s = ResultSelection(12)
        // ⇧↓ in the list: one more, the range keeps its start.
        s.adopt([12, 13], in: order)
        XCTAssertEqual(s.primary, 13)
        XCTAssertEqual(s.anchor, 12)
        // ⇧-click further down: the clicked end becomes primary.
        s.adopt([12, 13, 14, 15], in: order)
        XCTAssertEqual(s.primary, 15)
        XCTAssertEqual(s.anchor, 12)
        // ⇧-click back inside the range.
        s.adopt([12, 13, 14], in: order)
        XCTAssertEqual(s.primary, 14)
        XCTAssertEqual(s.anchor, 12)
        // ⇧-click above the anchor.
        s.adopt([10, 11, 12], in: order)
        XCTAssertEqual(s.primary, 10)
        XCTAssertEqual(s.anchor, 12)
        // ⌘-click a result apart from the range.
        s.adopt([10, 11, 12, 15], in: order)
        XCTAssertEqual(s.primary, 15)
        XCTAssertEqual(s.anchor, 15)
        // ⌘-click off one that is not the primary.
        s.adopt([10, 12, 15], in: order)
        XCTAssertEqual(s.primary, 15)
        // ⌘-click off the primary.
        s.adopt([10, 12], in: order)
        XCTAssertEqual(s.primary, 12)
        // ⌘A keeps the primary.
        s.adopt(Set(order), in: order)
        XCTAssertEqual(s.primary, 12)
        // A plain click.
        s.adopt([11], in: order)
        XCTAssertEqual(s, ResultSelection(11))
        s.adopt([], in: order)
        XCTAssertEqual(s, ResultSelection<Int>())
    }

    func testARangeOrClickReachingEveryResultIsNotSelectAll() {
        // ⇧↓ in the list, down to the last result.
        var s = ResultSelection(10)
        s.adopt([10, 11, 12, 13, 14], in: order)
        s.adopt(Set(order), in: order)
        XCTAssertEqual(s.primary, 15)
        XCTAssertEqual(s.anchor, 10)
        // ⌘-click the other of two results.
        var two = ResultSelection(1)
        two.adopt([1, 2], in: [1, 2])
        XCTAssertEqual(two.primary, 2)
    }

    func testANewQueryKeepsOnlyTheResultShown() {
        // How `SearchModel` carries the picks to a new query's results: collapsed first, so a
        // primary that is gone starts over at the top, not at another result that was picked.
        var s = ResultSelection(11)
        s.toggle(13, in: order)
        s.collapse()
        s.carry(over: [11: "/b", 13: "/d"], to: [(id: 10, key: "/a"), (id: 11, key: "/b")])
        XCTAssertEqual(s, ResultSelection(10))
    }
    func testCarriesOverByPath() {
        var s = ResultSelection(11)
        s.toggle(12, in: order)
        s.toggle(14, in: order)
        let old = [10: "/a", 11: "/b", 12: "/c", 13: "/d", 14: "/e"]
        // The index gave /b a new id, /e is gone, the order changed.
        s.carry(over: old, to: [(id: 12, key: "/c"), (id: 20, key: "/b"), (id: 10, key: "/a")])
        XCTAssertEqual(s.ids, [20, 12])
        XCTAssertEqual(s.primary, 12)
        XCTAssertEqual(s.anchor, 12)
        // The primary gone: the first picked result left, in the new order.
        s.carry(over: [12: "/c", 20: "/b", 10: "/a"], to: [(id: 10, key: "/a"), (id: 20, key: "/b")])
        XCTAssertEqual(s.ids, [20])
        XCTAssertEqual(s.primary, 20)
        // Nothing left: the first result.
        s.carry(over: [20: "/b"], to: [(id: 30, key: "/x"), (id: 31, key: "/y")])
        XCTAssertEqual(s, ResultSelection(30))
        s.carry(over: [:], to: [(id: 31, key: "/y")])
        XCTAssertEqual(s, ResultSelection(31))
        s.carry(over: [31: "/y"], to: [] as [(id: Int, key: String)])
        XCTAssertEqual(s, ResultSelection<Int>())
    }
}
