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
    var worktreePath: String?

    init(name: String) {
        self.name = name
    }
}

// MARK: - Projects

class Project: ObservableObject, Identifiable, Codable {
    let id: UUID
    @Published var name: String
    @Published var path: String
    @Published var useWorktrees: Bool

    enum CodingKeys: CodingKey {
        case id, name, path, useWorktrees
    }

    init(name: String, path: String, useWorktrees: Bool = false) {
        self.id = UUID()
        self.name = name
        self.path = path
        self.useWorktrees = useWorktrees
    }

    required init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        path = try c.decode(String.self, forKey: .path)
        useWorktrees = try c.decode(Bool.self, forKey: .useWorktrees)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(path, forKey: .path)
        try c.encode(useWorktrees, forKey: .useWorktrees)
    }

    /// Whether this project path is a git repository.
    var isGitRepo: Bool {
        FileManager.default.fileExists(atPath: (path as NSString).appendingPathComponent(".git"))
    }
}

@MainActor
class ProjectManager: ObservableObject {
    @Published var projects: [Project] = []
    @Published var activeProject: Project?

    private static let saveKey = "ClaudeDock.projects"
    private static let activeKey = "ClaudeDock.activeProjectID"

    init() {
        load()
    }

    func addProject(path: String) {
        let name = (path as NSString).lastPathComponent
        let project = Project(name: name, path: path)
        projects.append(project)
        if activeProject == nil {
            activeProject = project
        }
        save()
    }

    func removeProject(_ project: Project) {
        projects.removeAll { $0.id == project.id }
        if activeProject?.id == project.id {
            activeProject = projects.first
        }
        save()
    }

    func setActive(_ project: Project) {
        activeProject = project
        save()
    }

    func toggleWorktrees(for project: Project) {
        project.useWorktrees.toggle()
        save()
    }

    /// Creates a git worktree for the given slot name, returns the worktree path.
    func createWorktree(for project: Project, branchName: String) -> String? {
        guard project.isGitRepo else { return nil }

        let worktreePath = (project.path as NSString)
            .deletingLastPathComponent
            .appending("/\((project.path as NSString).lastPathComponent)-\(branchName)")

        let task = Process()
        task.launchPath = "/usr/bin/git"
        task.arguments = ["-C", project.path, "worktree", "add", worktreePath, "-b", branchName]
        task.standardOutput = Pipe()
        task.standardError = Pipe()

        do {
            try task.run()
            task.waitUntilExit()
            if task.terminationStatus == 0 {
                print("Created worktree at \(worktreePath)")
                return worktreePath
            } else {
                // Branch may already exist, try without -b
                let task2 = Process()
                task2.launchPath = "/usr/bin/git"
                task2.arguments = ["-C", project.path, "worktree", "add", worktreePath, branchName]
                task2.standardOutput = Pipe()
                task2.standardError = Pipe()
                try task2.run()
                task2.waitUntilExit()
                if task2.terminationStatus == 0 {
                    print("Created worktree at \(worktreePath) (existing branch)")
                    return worktreePath
                }
                print("Failed to create worktree")
                return nil
            }
        } catch {
            print("Worktree error: \(error)")
            return nil
        }
    }

    // MARK: - Persistence

    private func save() {
        if let data = try? JSONEncoder().encode(projects) {
            UserDefaults.standard.set(data, forKey: Self.saveKey)
        }
        UserDefaults.standard.set(activeProject?.id.uuidString, forKey: Self.activeKey)
    }

    private func load() {
        if let data = UserDefaults.standard.data(forKey: Self.saveKey),
           let saved = try? JSONDecoder().decode([Project].self, from: data) {
            projects = saved
        }
        if let idStr = UserDefaults.standard.string(forKey: Self.activeKey),
           let id = UUID(uuidString: idStr) {
            activeProject = projects.first { $0.id == id }
        }
    }
}
