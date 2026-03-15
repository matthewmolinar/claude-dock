import AppKit
import SwiftUI

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var dockPanel: FloatingPanel<DockView>!
    private var terminalManager: TerminalManager!
    private var isDockVisible = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        terminalManager = TerminalManager()

        setupDockPanel()
        setupMenuBar()
        setupHotkeys()
    }

    // MARK: - Dock Panel

    private func setupDockPanel() {
        let dockView = DockView(manager: terminalManager)
        dockPanel = FloatingPanel { dockView }

        positionDock()
        dockPanel.orderFront(nil)
    }

    private func rebuildDockPanel() {
        dockPanel.orderOut(nil)
        let dockView = DockView(manager: terminalManager)
        dockPanel = FloatingPanel { dockView }
        positionDock()
        if isDockVisible {
            dockPanel.orderFront(nil)
        }
    }

    private func positionDock() {
        guard let screen = NSScreen.main else { return }

        dockPanel.contentView?.layout()
        let contentSize = dockPanel.contentView?.fittingSize ?? CGSize(width: 400, height: 50)
        let config = terminalManager.config
        let placement = config.resolvedPlacement

        var x: CGFloat
        var y: CGFloat

        switch placement {
        case .bottom, .auto:
            x = screen.frame.origin.x + (screen.frame.width - contentSize.width) / 2
            y = screen.frame.origin.y + config.bottomOffset
        case .left:
            x = screen.frame.origin.x + config.sideOffset
            y = screen.frame.origin.y + (screen.frame.height - contentSize.height) / 2
        case .right:
            x = screen.frame.origin.x + screen.frame.width - contentSize.width - config.sideOffset
            y = screen.frame.origin.y + (screen.frame.height - contentSize.height) / 2
        }

        dockPanel.setFrame(
            NSRect(x: x, y: y, width: contentSize.width, height: contentSize.height),
            display: true
        )
    }

    // MARK: - Menu Bar

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "terminal", accessibilityDescription: "Claude Dock")
        }

        let menu = NSMenu()

        // Agent submenu
        let agentMenu = NSMenu()
        for agent in Agent.allCases {
            let item = NSMenuItem(title: agent.displayName, action: #selector(selectAgent(_:)), keyEquivalent: "")
            item.representedObject = agent
            item.state = agent == terminalManager.config.agent ? .on : .off
            agentMenu.addItem(item)
        }
        let agentItem = NSMenuItem(title: "Agent", action: nil, keyEquivalent: "")
        agentItem.submenu = agentMenu
        menu.addItem(agentItem)

        // Placement submenu
        let placementMenu = NSMenu()
        for placement in DockPlacement.allCases {
            let item = NSMenuItem(title: placement.displayName, action: #selector(selectPlacement(_:)), keyEquivalent: "")
            item.representedObject = placement.rawValue
            item.state = placement == terminalManager.config.placement ? .on : .off
            placementMenu.addItem(item)
        }
        let placementItem = NSMenuItem(title: "Position", action: nil, keyEquivalent: "")
        placementItem.submenu = placementMenu
        menu.addItem(placementItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Toggle Dock", action: #selector(toggleDock), keyEquivalent: "t"))
        menu.addItem(NSMenuItem(title: "New Terminal", action: #selector(addNewSlot), keyEquivalent: "n"))
        menu.addItem(NSMenuItem(title: "Minimize All", action: #selector(minimizeAll), keyEquivalent: "m"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Move macOS Dock Left", action: #selector(moveMacOSDockLeft), keyEquivalent: "l"))
        menu.addItem(NSMenuItem(title: "Move macOS Dock Right", action: #selector(moveMacOSDockRight), keyEquivalent: "r"))
        menu.addItem(NSMenuItem(title: "Move macOS Dock Bottom", action: #selector(moveMacOSDockBottom), keyEquivalent: "b"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    // MARK: - Hotkeys

    private func setupHotkeys() {
        HotkeyManager.shared.registerDockHotkeys(
            toggleDock: { [weak self] in self?.toggleDock() },
            newSlot: { [weak self] in self?.addNewSlot() },
            minimizeAll: { [weak self] in self?.minimizeAll() },
            moveDockLeft: { [weak self] in self?.moveMacOSDock(to: "left") },
            moveDockRight: { [weak self] in self?.moveMacOSDock(to: "right") },
            moveDockBottom: { [weak self] in self?.moveMacOSDock(to: "bottom") }
        )
    }

    // MARK: - Actions

    @objc private func toggleDock() {
        isDockVisible.toggle()
        if isDockVisible {
            positionDock()
            dockPanel.orderFront(nil)
        } else {
            dockPanel.orderOut(nil)
        }
    }

    @objc private func addNewSlot() {
        terminalManager.addSlotAndLaunch()
        positionDock()
    }

    @objc private func minimizeAll() {
        terminalManager.minimizeAll()
    }

    @objc private func moveMacOSDockLeft() { moveMacOSDock(to: "left") }
    @objc private func moveMacOSDockRight() { moveMacOSDock(to: "right") }
    @objc private func moveMacOSDockBottom() { moveMacOSDock(to: "bottom") }

    private func moveMacOSDock(to orientation: String) {
        let task = Process()
        task.launchPath = "/usr/bin/defaults"
        task.arguments = ["write", "com.apple.dock", "orientation", orientation]
        do {
            try task.run()
            task.waitUntilExit()
            let killTask = Process()
            killTask.launchPath = "/usr/bin/killall"
            killTask.arguments = ["Dock"]
            try killTask.run()
            killTask.waitUntilExit()
            print("macOS Dock moved to \(orientation)")
            // Auto placement may have changed, rebuild
            if terminalManager.config.placement == .auto {
                rebuildDockPanel()
            } else {
                positionDock()
            }
        } catch {
            print("Failed to move macOS Dock: \(error)")
        }
    }

    @objc private func selectAgent(_ sender: NSMenuItem) {
        guard let agent = sender.representedObject as? Agent else { return }
        terminalManager.config.agent = agent
        if let menu = sender.menu {
            for item in menu.items {
                item.state = (item.representedObject as? Agent) == agent ? .on : .off
            }
        }
    }

    @objc private func selectPlacement(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let placement = DockPlacement(rawValue: raw) else { return }
        terminalManager.config.placement = placement
        if let menu = sender.menu {
            for item in menu.items {
                item.state = (item.representedObject as? String) == raw ? .on : .off
            }
        }
        rebuildDockPanel()
    }
}
