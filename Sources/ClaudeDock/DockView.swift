import SwiftUI
import AppKit

struct DockView: View {
    @ObservedObject var manager: TerminalManager
    @State private var plusHovering = false

    private var isVertical: Bool { manager.config.isVertical }

    var body: some View {
        let layout = isVertical ? AnyLayout(VStackLayout(spacing: 2)) : AnyLayout(HStackLayout(spacing: 2))

        layout {
            // Logo
            if isVertical {
                Text("MOLINAR")
                    .font(.system(size: 9, weight: .medium))
                    .tracking(3)
                    .foregroundColor(.white.opacity(0.35))
                    .fixedSize()
                    .rotationEffect(.degrees(-90))
                    .frame(width: 36, height: 80)
            } else {
                Text("MOLINAR")
                    .font(.system(size: 10, weight: .medium))
                    .tracking(4)
                    .foregroundColor(.white.opacity(0.35))
                    .padding(.horizontal, 10)
            }

            ForEach(manager.slots) { slot in
                SlotView(
                    slot: slot,
                    isVertical: isVertical,
                    onClick: { handleClick(slot) },
                    onOptionClick: { promptRename(slot) }
                )
            }

            Button(action: { handleAddSlot() }) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .light))
                    .foregroundColor(.white.opacity(plusHovering ? 0.5 : 0.2))
                    .frame(
                        width: isVertical ? 36 : 28,
                        height: isVertical ? 28 : 48
                    )
                    .background(
                        Capsule().fill(.white.opacity(plusHovering ? 0.08 : 0.0))
                    )
            }
            .buttonStyle(.plain)
            .onHover { h in plusHovering = h }
        }
        .padding(isVertical ? .vertical : .horizontal, 6)
        .padding(isVertical ? .horizontal : .vertical, 5)
        .background(
            ZStack {
                VisualEffectBlur()
                Color.black.opacity(0.55)
            }
            .clipShape(Capsule())
        )
    }

    private func handleClick(_ slot: Slot) {
        switch slot.state {
        case .empty:
            promptNameAndLaunch(slot)
        case .active, .minimized, .otherSpace:
            manager.focusSlot(slot)
        }
    }

    private func handleAddSlot() {
        manager.addSlot()
        if let newSlot = manager.slots.last {
            promptNameAndLaunch(newSlot)
        }
    }

    private func promptNameAndLaunch(_ slot: Slot) {
        let name = showInputDialog(title: "New agent", defaultValue: slot.name)
        guard let name = name, !name.isEmpty else { return }
        manager.renameSlot(slot, to: name)
        manager.launchTerminal(for: slot)
    }

    private func promptRename(_ slot: Slot) {
        let name = showInputDialog(title: "Rename", defaultValue: slot.name)
        guard let name = name, !name.isEmpty else { return }
        manager.renameSlot(slot, to: name)
    }

    private func showInputDialog(title: String, defaultValue: String) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
        input.stringValue = defaultValue
        alert.accessoryView = input
        alert.window.initialFirstResponder = input

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            return input.stringValue
        }
        return nil
    }
}

struct VisualEffectBlur: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
