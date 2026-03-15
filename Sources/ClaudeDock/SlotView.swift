import SwiftUI

enum Factory {
    static let green = Color(red: 0.3, green: 0.95, blue: 0.5)
    static let red = Color(red: 1.0, green: 0.3, blue: 0.25)
}

struct SlotView: View {
    @ObservedObject var slot: Slot
    var isVertical: Bool = false
    var onClick: () -> Void
    var onOptionClick: () -> Void
    @State private var isHovering = false

    private var dotColor: Color {
        switch slot.state {
        case .empty: return .white.opacity(0.15)
        case .active: return Factory.green
        case .minimized, .otherSpace: return .white.opacity(0.4)
        }
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if isVertical {
                HStack(spacing: 5) {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 5, height: 5)

                    Text(slot.name)
                        .font(.system(size: 12, weight: slot.state == .active ? .medium : .regular))
                        .foregroundColor(slot.state == .empty ? .white.opacity(0.25) : .white.opacity(0.8))
                        .lineLimit(1)
                }
                .frame(width: 80, height: 32)
                .background(
                    Capsule().fill(.white.opacity(isHovering ? 0.1 : 0.0))
                )
            } else {
                HStack(spacing: 6) {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 5, height: 5)

                    Text(slot.name)
                        .font(.system(size: 13, weight: slot.state == .active ? .medium : .regular))
                        .foregroundColor(slot.state == .empty ? .white.opacity(0.25) : .white.opacity(0.8))
                        .lineLimit(1)
                }
                .frame(height: 48)
                .padding(.horizontal, 14)
                .background(
                    Capsule().fill(.white.opacity(isHovering ? 0.1 : 0.0))
                )
            }

            if slot.hasNotification {
                Circle()
                    .fill(Factory.red)
                    .frame(width: 6, height: 6)
                    .offset(x: -4, y: 2)
            }
        }
        .onHover { hovering in isHovering = hovering }
        .onTapGesture {
            if NSEvent.modifierFlags.contains(.option) {
                onOptionClick()
            } else {
                onClick()
            }
        }
    }
}
