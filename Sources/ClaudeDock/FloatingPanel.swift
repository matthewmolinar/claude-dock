import AppKit
import SwiftUI

/// A non-activating floating panel (Wispr Flow style).
/// Does not steal focus from other apps when clicked.
class FloatingPanel<Content: View>: NSPanel {
    init(content: @escaping () -> Content) {
        super.init(
            contentRect: .zero,
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        titleVisibility = .hidden
        titlebarAppearsTransparent = true

        // Host SwiftUI content
        let hostingView = NSHostingView(rootView: content())
        contentView = hostingView
    }

    // Allow the panel to become key so buttons work, but it won't activate the app
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
