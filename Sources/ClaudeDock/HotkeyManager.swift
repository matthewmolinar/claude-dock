import AppKit
import Carbon

/// Manages global keyboard shortcuts using Carbon hotkey API.
class HotkeyManager {
    struct Hotkey {
        let id: UInt32
        let keyCode: UInt32
        let modifiers: UInt32
        let handler: () -> Void
    }

    private var hotkeys: [UInt32: Hotkey] = [:]
    private var hotkeyRefs: [EventHotKeyRef?] = []
    private var eventHandler: EventHandlerRef?

    static let shared = HotkeyManager()

    /// Carbon modifier flags
    static let cmdKey: UInt32 = UInt32(cmdKey)
    static let optionKey: UInt32 = UInt32(optionKey)

    private init() {
        installEventHandler()
    }

    func register(id: UInt32, keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) {
        let hotkey = Hotkey(id: id, keyCode: keyCode, modifiers: modifiers, handler: handler)
        hotkeys[id] = hotkey

        let hotkeyID = EventHotKeyID(signature: OSType(0x434C4455), id: id) // "CLDU"
        var hotkeyRef: EventHotKeyRef?

        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotkeyID,
            GetApplicationEventTarget(),
            0,
            &hotkeyRef
        )

        if status == noErr {
            hotkeyRefs.append(hotkeyRef)
        }
    }

    private func installEventHandler() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))

        let handler: EventHandlerUPP = { _, event, _ -> OSStatus in
            var hotkeyID = EventHotKeyID()
            GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hotkeyID
            )

            DispatchQueue.main.async {
                HotkeyManager.shared.hotkeys[hotkeyID.id]?.handler()
            }

            return noErr
        }

        InstallEventHandler(
            GetApplicationEventTarget(),
            handler,
            1,
            &eventType,
            nil,
            &eventHandler
        )
    }

    /// Register all dock hotkeys
    func registerDockHotkeys(
        toggleDock: @escaping () -> Void,
        newSlot: @escaping () -> Void,
        minimizeAll: @escaping () -> Void,
        reload: @escaping () -> Void
    ) {
        // Cmd+Option+T - Toggle dock (T = keycode 17)
        register(id: 1, keyCode: 17, modifiers: UInt32(Carbon.cmdKey) | UInt32(Carbon.optionKey), handler: toggleDock)
        // Cmd+Option+N - New slot (N = keycode 45)
        register(id: 2, keyCode: 45, modifiers: UInt32(Carbon.cmdKey) | UInt32(Carbon.optionKey), handler: newSlot)
        // Cmd+Option+M - Minimize all (M = keycode 46)
        register(id: 3, keyCode: 46, modifiers: UInt32(Carbon.cmdKey) | UInt32(Carbon.optionKey), handler: minimizeAll)
        // Cmd+Option+R - Reload (R = keycode 15)
        register(id: 4, keyCode: 15, modifiers: UInt32(Carbon.cmdKey) | UInt32(Carbon.optionKey), handler: reload)
    }
}
