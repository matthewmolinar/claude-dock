import AppKit
import Combine

// Private Accessibility API to get CGWindowID from AXUIElement
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Manages terminal windows and agent sessions.
@MainActor
class TerminalManager: ObservableObject {
    @Published var slots: [Slot] = []
    @Published var config = DockConfig()

    private var windowCheckTimer: Timer?

    init() {
        // Create initial empty slots
        for i in 1...config.initialSlots {
            slots.append(Slot(name: "\(i)"))
        }
        startWindowMonitoring()
    }

    // MARK: - Slot Management

    func addSlot() {
        let index = slots.count + 1
        let slot = Slot(name: "\(index)")
        slots.append(slot)
    }

    func addSlotAndLaunch() {
        let index = slots.count + 1
        let slot = Slot(name: "\(index)")
        slots.append(slot)
        launchTerminal(for: slot)
    }

    // MARK: - Terminal Launching

    func launchTerminal(for slot: Slot) {
        let agent = config.agent.launchCommand

        // Use osascript to open a new Terminal window and run the agent
        let script = """
        tell application "Terminal"
            activate
            set newWindow to do script "\(agent)"
            set custom title of front window to "ClaudeDock: \(slot.name)"
        end tell
        """

        let task = Process()
        task.launchPath = "/usr/bin/osascript"
        task.arguments = ["-e", script]

        do {
            try task.run()
            task.waitUntilExit()

            // Give Terminal a moment to create the window, then capture its ID
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.associateWindow(with: slot)
            }

            slot.state = .active
        } catch {
            print("Failed to launch terminal: \(error)")
        }
    }

    func focusSlot(_ slot: Slot) {
        guard let windowID = slot.windowID else { return }

        // Find the window and bring it to front
        let appRef = AXUIElementCreateApplication(slot.terminalPID ?? 0)
        var windowList: CFTypeRef?
        AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute as CFString, &windowList)

        if let windows = windowList as? [AXUIElement] {
            for window in windows {
                var windowIDValue: CGWindowID = 0
                _ = _AXUIElementGetWindow(window, &windowIDValue)
                if windowIDValue == windowID {
                    AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, false as CFTypeRef)
                    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                    NSRunningApplication(processIdentifier: slot.terminalPID ?? 0)?.activate()
                    slot.state = .active
                    slot.hasNotification = false
                    break
                }
            }
        }
    }

    func minimizeAll() {
        for slot in slots where slot.state == .active {
            guard let windowID = slot.windowID else { continue }
            let appRef = AXUIElementCreateApplication(slot.terminalPID ?? 0)
            var windowList: CFTypeRef?
            AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute as CFString, &windowList)

            if let windows = windowList as? [AXUIElement] {
                for window in windows {
                    var windowIDValue: CGWindowID = 0
                    _ = _AXUIElementGetWindow(window, &windowIDValue)
                    if windowIDValue == windowID {
                        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, true as CFTypeRef)
                        slot.state = .minimized
                        break
                    }
                }
            }
        }
    }

    // MARK: - Window Tracking

    private func associateWindow(with slot: Slot) {
        // Find the most recently created Terminal window
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windowInfoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return }

        for windowInfo in windowInfoList {
            guard let ownerName = windowInfo[kCGWindowOwnerName as String] as? String,
                  ownerName == "Terminal",
                  let windowID = windowInfo[kCGWindowNumber as String] as? CGWindowID,
                  let ownerPID = windowInfo[kCGWindowOwnerPID as String] as? pid_t,
                  let windowName = windowInfo[kCGWindowName as String] as? String,
                  windowName.contains("ClaudeDock: \(slot.name)") || windowName.contains(config.agent.launchCommand)
            else { continue }

            // Make sure this window isn't already assigned to another slot
            let alreadyAssigned = slots.contains { $0.windowID == windowID && $0.id != slot.id }
            if !alreadyAssigned {
                slot.windowID = windowID
                slot.terminalPID = ownerPID
                slot.state = .active
                return
            }
        }

        // Fallback: grab the frontmost Terminal window
        for windowInfo in windowInfoList {
            guard let ownerName = windowInfo[kCGWindowOwnerName as String] as? String,
                  ownerName == "Terminal",
                  let windowID = windowInfo[kCGWindowNumber as String] as? CGWindowID,
                  let ownerPID = windowInfo[kCGWindowOwnerPID as String] as? pid_t
            else { continue }

            let alreadyAssigned = slots.contains { $0.windowID == windowID }
            if !alreadyAssigned {
                slot.windowID = windowID
                slot.terminalPID = ownerPID
                slot.state = .active
                return
            }
        }
    }

    private func startWindowMonitoring() {
        windowCheckTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.updateWindowStates()
            }
        }
    }

    private func updateWindowStates() {
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard let windowInfoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return }

        let onScreenWindows = Set(
            windowInfoList.compactMap { info -> CGWindowID? in
                guard let id = info[kCGWindowNumber as String] as? CGWindowID,
                      let isOnScreen = info[kCGWindowIsOnscreen as String] as? Bool,
                      isOnScreen else { return nil }
                return id
            }
        )

        let allWindowIDs = Set(
            windowInfoList.compactMap { $0[kCGWindowNumber as String] as? CGWindowID }
        )

        for slot in slots {
            guard let windowID = slot.windowID else {
                slot.state = .empty
                continue
            }

            if !allWindowIDs.contains(windowID) {
                // Window was closed
                slot.state = .empty
                slot.windowID = nil
                slot.terminalPID = nil
            } else if onScreenWindows.contains(windowID) {
                slot.state = .active
            } else {
                slot.state = .minimized
            }
        }
    }

    func renameSlot(_ slot: Slot, to name: String) {
        slot.name = name
    }
}
