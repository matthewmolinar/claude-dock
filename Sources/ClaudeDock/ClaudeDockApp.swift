import SwiftUI

@main
struct ClaudeDockApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // No visible window — the dock is managed by AppDelegate via FloatingPanel.
        // Menu bar and hotkeys are set up in AppDelegate.
        Settings {
            EmptyView()
        }
    }
}
