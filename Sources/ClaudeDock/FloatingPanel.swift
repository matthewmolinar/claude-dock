import AppKit
import SwiftUI

/// An NSHostingView subclass that accepts first mouse clicks,
/// so the panel responds immediately without needing activation first.
class ClickThroughHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

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
        acceptsMouseMovedEvents = true

        // Host SwiftUI content with click-through support
        let hostingView = ClickThroughHostingView(rootView: content())
        contentView = hostingView
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
