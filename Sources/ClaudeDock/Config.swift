import Foundation

enum Agent: String, CaseIterable {
    case claude = "claude"
    case amp = "amp"
    case codex = "codex"

    var launchCommand: String {
        switch self {
        case .claude: return "claude"
        case .amp: return "amp"
        case .codex: return "codex"
        }
    }

    var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .amp: return "Amp"
        case .codex: return "Codex"
        }
    }
}

struct DockConfig {
    var agent: Agent = .claude
    var slotWidth: CGFloat = 140
    var slotHeight: CGFloat = 60
    var gap: CGFloat = 8
    var margin: CGFloat = 10
    var bottomOffset: CGFloat = 5
    var initialSlots: Int = 3
}
