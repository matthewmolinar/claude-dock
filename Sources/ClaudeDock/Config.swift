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

enum DockPlacement: String, CaseIterable {
    case bottom
    case left
    case right
    case auto // picks side opposite macOS Dock, or bottom if macOS Dock is on a side

    var displayName: String {
        switch self {
        case .bottom: return "Bottom"
        case .left: return "Left"
        case .right: return "Right"
        case .auto: return "Auto"
        }
    }
}

struct DockConfig {
    var agent: Agent = .claude
    var placement: DockPlacement = .auto
    var bottomOffset: CGFloat = 5
    var sideOffset: CGFloat = 5
    var initialSlots: Int = 3

    /// Returns where the dock should actually go, resolving .auto based on macOS Dock position.
    var resolvedPlacement: DockPlacement {
        guard placement == .auto else { return placement }
        let macOSDock = DockConfig.macOSDockOrientation()
        switch macOSDock {
        case "bottom": return .right
        case "left": return .bottom
        case "right": return .bottom
        default: return .bottom
        }
    }

    var isVertical: Bool {
        let p = resolvedPlacement
        return p == .left || p == .right
    }

    /// Read the macOS Dock orientation from defaults.
    static func macOSDockOrientation() -> String {
        let task = Process()
        task.launchPath = "/usr/bin/defaults"
        task.arguments = ["read", "com.apple.dock", "orientation"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "bottom"
        } catch {
            return "bottom"
        }
    }
}
