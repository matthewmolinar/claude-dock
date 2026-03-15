import AppKit
import SwiftUI

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var dockPanel: FloatingPanel<DockView>!
    private var terminalManager: TerminalManager!
    private var isDockVisible = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide from Dock (backup — Info.plist LSUIElement should handle this)
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

    private func positionDock() {
        guard let screen = NSScreen.main else { return }

        // Let the panel size itself to fit the SwiftUI content
        dockPanel.contentView?.layout()

        let contentSize = dockPanel.contentView?.fittingSize ?? CGSize(width: 500, height: 80)
        let x = (screen.frame.width - contentSize.width) / 2 + screen.frame.origin.x
        let y = screen.frame.origin.y + terminalManager.config.bottomOffset

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

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Toggle Dock", action: #selector(toggleDock), keyEquivalent: "t"))
        menu.addItem(NSMenuItem(title: "New Terminal", action: #selector(addNewSlot), keyEquivalent: "n"))
        menu.addItem(NSMenuItem(title: "Minimize All", action: #selector(minimizeAll), keyEquivalent: "m"))
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
            reload: { [weak self] in self?.reload() }
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

    @objc private func reload() {
        positionDock()
    }

    @objc private func selectAgent(_ sender: NSMenuItem) {
        guard let agent = sender.representedObject as? Agent else { return }
        terminalManager.config.agent = agent

        // Update menu checkmarks
        if let menu = sender.menu {
            for item in menu.items {
                item.state = (item.representedObject as? Agent) == agent ? .on : .off
            }
        }
    }
}
