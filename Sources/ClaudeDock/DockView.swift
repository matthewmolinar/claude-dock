import SwiftUI
import AppKit
import os.log

private let logger = Logger(subsystem: "com.molinar.ClaudeDock", category: "DockView")

struct FolderTabShape: Shape {
    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 6
        var p = Path()
        p.move(to: CGPoint(x: 0, y: rect.maxY))
        p.addLine(to: CGPoint(x: 0, y: rect.minY + r))
        p.addQuadCurve(to: CGPoint(x: r, y: rect.minY), control: CGPoint(x: 0, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}

struct DockView: View {
    @ObservedObject var manager: TerminalManager
    @ObservedObject var projectManager: ProjectManager
    @State private var plusHovering = false
    @State private var projHovering = false

    private var isVertical: Bool { manager.config.isVertical }
    private var pm: ProjectManager { projectManager }

    var body: some View {
        if isVertical {
            verticalBody
        } else {
            horizontalBody
        }
    }

    // MARK: - Horizontal (bottom)

    private var horizontalBody: some View {
        ZStack(alignment: .topTrailing) {
            horizontalPill
                .padding(.top, 14)

            // Folder tab — right side, like a manila folder tab
            Text("MOLINAR")
                .font(.system(size: 8, weight: .bold))
                .tracking(3)
                .foregroundColor(.white.opacity(0.45))
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .padding(.bottom, 6)
                .background(
                    ZStack {
                        VisualEffectBlur()
                        Color.black.opacity(0.55)
                    }
                    .clipShape(FolderTabShape())
                )
                .padding(.trailing, 24)
        }
    }

    private var horizontalPill: some View {
        HStack(spacing: 2) {
            projectButton

            ForEach(manager.slots) { slot in
                SlotView(
                    slot: slot,
                    isVertical: false,
                    onClick: { handleClick(slot) },
                    onOptionClick: { promptRename(slot) }
                )
            }

            Image(systemName: "plus")
                .font(.system(size: 11, weight: .light))
                .foregroundColor(.white.opacity(plusHovering ? 0.5 : 0.2))
                .frame(width: 28, height: 48)
                .background(Capsule().fill(.white.opacity(plusHovering ? 0.08 : 0.0)))
                .onHover { h in plusHovering = h }
                .onTapGesture { handleAddSlot() }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(
            ZStack {
                VisualEffectBlur()
                Color.black.opacity(0.55)
            }
            .clipShape(Capsule())
        )
    }

    // MARK: - Vertical (side)

    private var verticalBody: some View {
        VStack(spacing: 2) {
            Text("MOLINAR")
                .font(.system(size: 8, weight: .bold))
                .tracking(2)
                .foregroundColor(.white.opacity(0.5))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    ZStack {
                        VisualEffectBlur()
                        Color.black.opacity(0.55)
                    }
                    .clipShape(FolderTabShape())
                )

            VStack(spacing: 2) {
                projectButton

                ForEach(manager.slots) { slot in
                    SlotView(
                        slot: slot,
                        isVertical: true,
                        onClick: { handleClick(slot) },
                        onOptionClick: { promptRename(slot) }
                    )
                }

                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .light))
                    .foregroundColor(.white.opacity(plusHovering ? 0.5 : 0.2))
                    .frame(width: 36, height: 28)
                    .background(Capsule().fill(.white.opacity(plusHovering ? 0.08 : 0.0)))
                    .onHover { h in plusHovering = h }
                    .onTapGesture { handleAddSlot() }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 5)
            .background(
                ZStack {
                    VisualEffectBlur()
                    Color.black.opacity(0.55)
                }
                .clipShape(Capsule())
            )
        }
    }

    // MARK: - Project Button

    @ViewBuilder
    private var projectButton: some View {
        let projectName = pm.activeProject?.name ?? "no project"
        let worktreeOn = pm.activeProject?.useWorktrees == true

        if isVertical {
            VStack(spacing: 2) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 10))
                    .foregroundColor(pm.activeProject != nil ? .white.opacity(0.7) : .white.opacity(0.2))
                Text(projectName)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(pm.activeProject != nil ? .white.opacity(0.7) : .white.opacity(0.25))
                    .lineLimit(1)
                if worktreeOn {
                    Image(systemName: "arrow.branch")
                        .font(.system(size: 8))
                        .foregroundColor(.white.opacity(0.35))
                }
            }
            .frame(width: 80, height: 48)
            .background(Capsule().fill(.white.opacity(projHovering ? 0.1 : 0.04)))
            .onHover { h in projHovering = h }
            .onTapGesture { showProjectMenu() }
        } else {
            HStack(spacing: 5) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 10))
                    .foregroundColor(pm.activeProject != nil ? .white.opacity(0.7) : .white.opacity(0.2))
                Text(projectName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(pm.activeProject != nil ? .white.opacity(0.7) : .white.opacity(0.25))
                    .lineLimit(1)
                if worktreeOn {
                    Image(systemName: "arrow.branch")
                        .font(.system(size: 9))
                        .foregroundColor(.white.opacity(0.35))
                }
            }
            .frame(height: 48)
            .padding(.horizontal, 12)
            .background(Capsule().fill(.white.opacity(projHovering ? 0.1 : 0.04)))
            .onHover { h in projHovering = h }
            .onTapGesture { showProjectMenu() }
        }
    }

    // MARK: - Actions

    private func showProjectMenu() {
        logger.notice("showProjectMenu called, projects: \(self.pm.projects.count)")
        let projects = pm.projects

        let alert = NSAlert()
        alert.messageText = "Select Project"

        // Build button list: each project + Add New
        if !projects.isEmpty {
            for project in projects {
                let prefix = pm.activeProject?.id == project.id ? "● " : ""
                alert.addButton(withTitle: "\(prefix)\(project.name)")
            }
        }
        alert.addButton(withTitle: "Add Folder...")
        alert.addButton(withTitle: "Cancel")

        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()

        let buttonIndex = response.rawValue - 1000 // NSAlert buttons start at 1000

        logger.notice("showProjectMenu: buttonIndex=\(buttonIndex), projectCount=\(projects.count)")
        if buttonIndex < projects.count {
            logger.notice("showProjectMenu: selecting project \(projects[buttonIndex].name)")
            pm.setActive(projects[buttonIndex])
            logger.notice("showProjectMenu: activeProject is now \(self.pm.activeProject?.name ?? "nil")")
        } else if buttonIndex == projects.count {
            // "Add Folder..."
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.message = "Choose a project folder"
            if panel.runModal() == .OK, let url = panel.url {
                pm.addProject(path: url.path)
            }
        }
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
        logger.notice("handleAddSlot called, current slots: \(self.manager.slots.count)")
        manager.addSlot()
        logger.notice("handleAddSlot after addSlot, slots: \(self.manager.slots.count)")
        if let newSlot = manager.slots.last {
            logger.notice("handleAddSlot prompting for name")
            promptNameAndLaunch(newSlot)
        } else {
            logger.error("handleAddSlot: no last slot!")
        }
    }

    private func promptNameAndLaunch(_ slot: Slot) {
        logger.notice("promptNameAndLaunch for slot: \(slot.name)")
        let name = showInputDialog(title: "New agent", defaultValue: slot.name)
        guard let name = name, !name.isEmpty else {
            logger.notice("promptNameAndLaunch: cancelled or empty")
            return
        }
        logger.notice("promptNameAndLaunch: launching with name=\(name)")
        manager.renameSlot(slot, to: name)
        manager.launchTerminal(for: slot)
    }

    private func promptRename(_ slot: Slot) {
        let name = showInputDialog(title: "Rename", defaultValue: slot.name)
        guard let name = name, !name.isEmpty else { return }
        manager.renameSlot(slot, to: name)
    }

    private func showInputDialog(title: String, defaultValue: String) -> String? {
        // Temporarily activate app so the dialog appears in front
        NSApp.activate(ignoringOtherApps: true)

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
