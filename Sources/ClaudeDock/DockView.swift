import SwiftUI

struct DockView: View {
    @ObservedObject var manager: TerminalManager
    @State private var isRenaming = false
    @State private var renameSlot: Slot?
    @State private var renameText = ""

    var body: some View {
        HStack(spacing: 8) {
            ForEach(manager.slots) { slot in
                SlotView(
                    slot: slot,
                    onClick: { handleClick(slot) },
                    onOptionClick: { startRename(slot) }
                )
            }

            // Add button
            Button(action: { manager.addSlotAndLaunch() }) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color.white.opacity(0.1))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color.white.opacity(0.2), lineWidth: 1)
                        )

                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .light))
                        .foregroundColor(.white.opacity(0.6))
                }
                .frame(width: 40, height: 50)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(
            VisualEffectBlur()
                .clipShape(RoundedRectangle(cornerRadius: 16))
        )
        .sheet(isPresented: $isRenaming) {
            RenameSheet(name: $renameText, isPresented: $isRenaming) {
                if let slot = renameSlot {
                    manager.renameSlot(slot, to: renameText)
                }
            }
        }
    }

    private func handleClick(_ slot: Slot) {
        switch slot.state {
        case .empty:
            startRename(slot, thenLaunch: true)
        case .active, .minimized, .otherSpace:
            manager.focusSlot(slot)
        }
    }

    private func startRename(_ slot: Slot, thenLaunch: Bool = false) {
        renameSlot = slot
        renameText = slot.name
        isRenaming = true

        if thenLaunch {
            // After rename completes, launch terminal
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                // The sheet dismissal handler will check this
            }
        }
    }
}

// MARK: - Rename Sheet

struct RenameSheet: View {
    @Binding var name: String
    @Binding var isPresented: Bool
    var onConfirm: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Name this slot")
                .font(.headline)

            TextField("Enter name", text: $name)
                .textFieldStyle(.roundedBorder)
                .frame(width: 200)
                .onSubmit { confirm() }

            HStack(spacing: 12) {
                Button("Cancel") { isPresented = false }
                    .keyboardShortcut(.cancelAction)

                Button("OK") { confirm() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
    }

    private func confirm() {
        onConfirm()
        isPresented = false
    }
}

// MARK: - Visual Effect (vibrancy blur)

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
