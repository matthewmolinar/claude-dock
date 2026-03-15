import SwiftUI

struct SlotView: View {
    @ObservedObject var slot: Slot
    var onClick: () -> Void
    var onOptionClick: () -> Void

    private var backgroundColor: Color {
        switch slot.state {
        case .empty:
            return Color.gray.opacity(0.3)
        case .active:
            return Color.green.opacity(0.6)
        case .minimized, .otherSpace:
            return Color.blue.opacity(0.5)
        }
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Slot background
            RoundedRectangle(cornerRadius: 10)
                .fill(backgroundColor)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.white.opacity(0.2), lineWidth: 1)
                )

            // Slot content
            VStack(spacing: 2) {
                Text(slot.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white)
                    .lineLimit(1)

                Text(stateLabel)
                    .font(.system(size: 10))
                    .foregroundColor(.white.opacity(0.6))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Notification badge
            if slot.hasNotification {
                Circle()
                    .fill(Color.red)
                    .frame(width: 10, height: 10)
                    .offset(x: -4, y: 4)
            }
        }
        .frame(width: 130, height: 50)
        .onTapGesture {
            if NSEvent.modifierFlags.contains(.option) {
                onOptionClick()
            } else {
                onClick()
            }
        }
        .help(slot.state == .empty ? "Click to open terminal" : "Click to focus • Option+Click to rename")
    }

    private var stateLabel: String {
        switch slot.state {
        case .empty: return "empty"
        case .active: return "active"
        case .minimized: return "minimized"
        case .otherSpace: return "other space"
        }
    }
}
