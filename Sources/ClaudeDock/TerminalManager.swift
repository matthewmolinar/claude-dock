import AppKit
import Combine
import os.log

private let logger = Logger(subsystem: "com.molinar.ClaudeDock", category: "TerminalManager")

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Manages terminal windows and agent sessions.
@MainActor
class TerminalManager: ObservableObject {
    @Published var slots: [Slot] = []
    @Published var config = DockConfig()
    @Published var projectManager = ProjectManager()

    private var windowCheckTimer: Timer?

    init() {
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
        logger.notice("addSlot: now \(self.slots.count) slots")
    }

    func addSlotAndLaunch() {
        let index = slots.count + 1
        let slot = Slot(name: "\(index)")
        slots.append(slot)
        logger.notice("addSlotAndLaunch: now \(self.slots.count) slots")
        launchTerminal(for: slot)
    }

    // MARK: - Terminal Launching

    func launchTerminal(for slot: Slot) {
        logger.notice("launchTerminal: slot=\(slot.name)")
        let agent = config.agent.launchCommand
        let project = projectManager.activeProject

        // Determine working directory
        var workDir: String?

        if let project = project {
            if project.useWorktrees && project.isGitRepo {
                // Create worktree with slot name as branch
                let branchName = slot.name
                    .lowercased()
                    .replacingOccurrences(of: " ", with: "-")
                    .replacingOccurrences(of: "[^a-z0-9\\-]", with: "", options: .regularExpression)

                if let wtPath = projectManager.createWorktree(for: project, branchName: branchName) {
                    workDir = wtPath
                    slot.worktreePath = wtPath
                } else {
                    workDir = project.path
                }
            } else {
                workDir = project.path
            }
        }

        // Build the terminal command
        var commands: [String] = []
        if let dir = workDir {
            commands.append("cd '\(dir)'")
        }
        commands.append(agent)
        let fullCommand = commands.joined(separator: " && ")

        let script = """
        tell application "Terminal"
            activate
            set newWindow to do script "\(fullCommand)"
            set custom title of front window to "ClaudeDock: \(slot.name)"
        end tell
        """

        let task = Process()
        task.launchPath = "/usr/bin/osascript"
        task.arguments = ["-e", script]

        do {
            try task.run()
            task.waitUntilExit()

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
