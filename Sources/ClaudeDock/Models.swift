import AppKit

enum SlotState {
    case empty
    case active
    case minimized
    case otherSpace
}

class Slot: ObservableObject, Identifiable {
    let id = UUID()
    @Published var name: String
    @Published var state: SlotState = .empty
    @Published var hasNotification: Bool = false
    var windowID: CGWindowID?
    var terminalPID: pid_t?

    init(name: String) {
        self.name = name
    }
}
