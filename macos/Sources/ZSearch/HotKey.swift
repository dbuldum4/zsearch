#if os(macOS)
import Carbon.HIToolbox
import Foundation

/// The shortcut that brings zsearch forward from any app.
enum HotKeyChoice: String, CaseIterable, Identifiable {
    case off
    case optionSpace
    case controlOptionSpace
    case commandShiftSpace

    var id: String { rawValue }

    var label: String {
        switch self {
        case .off: return "None"
        case .optionSpace: return "⌥ Space"
        case .controlOptionSpace: return "⌃⌥ Space"
        case .commandShiftSpace: return "⇧⌘ Space"
        }
    }

    /// Carbon key code and modifier mask, or nil for `.off`.
    var carbon: (keyCode: UInt32, modifiers: UInt32)? {
        let space = UInt32(kVK_Space)
        switch self {
        case .off: return nil
        case .optionSpace: return (space, UInt32(optionKey))
        case .controlOptionSpace: return (space, UInt32(controlKey | optionKey))
        case .commandShiftSpace: return (space, UInt32(cmdKey | shiftKey))
        }
    }
}

/// A system-wide keyboard shortcut. Uses Carbon's RegisterEventHotKey, which needs no
/// accessibility permission. Unregistered when released.
final class HotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: () -> Void

    init?(_ choice: HotKeyChoice, action: @escaping () -> Void) {
        guard let carbon = choice.carbon else { return nil }
        self.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData in
                guard let userData else { return OSStatus(eventNotHandledErr) }
                let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { hotKey.action() }
                return noErr
            },
            1,
            &spec,
            Unmanaged.passUnretained(self).toOpaque(),
            &handlerRef
        )
        guard installed == noErr else { return nil }
        let id = EventHotKeyID(signature: OSType(0x7A73_6368), id: 1) // 'zsch'
        let registered = RegisterEventHotKey(carbon.keyCode, carbon.modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
        guard registered == noErr else {
            if let handlerRef { RemoveEventHandler(handlerRef) }
            handlerRef = nil
            return nil
        }
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
#endif
