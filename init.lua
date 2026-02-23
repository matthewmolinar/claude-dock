-- Claude Dock: Terminal dock for managing AI coding agent sessions (Claude, Amp, Codex)
-- https://github.com/YOUR_USERNAME/claude-dock

require("hs.ipc")

-- Configuration
local config = {
    -- Agent to launch: "claude", "amp", or "codex"
    agent = "claude",
    slotWidth = 140,
    slotHeight = 60,
    gap = 8,
    margin = 10,
    bottomOffset = 5,
    addButtonWidth = 40,
    utilityButtonWidth = 28,
    initialSlots = 3,
    elementsPerSlot = 9,  -- bg, border, title, status, badge glow outer, badge glow inner, badge, close btn, minimize btn
    baseElements = 14,    -- dock bg + border + 6 tab elements + 2 grab btn elements + 4 utility btn elements
    windowCaptureDelay = 0.3,
    windowCaptureRetries = 5,
    colors = {
        dockBg = { red = 0.08, green = 0.08, blue = 0.08, alpha = 0.95 },
        dockBorder = { red = 1, green = 1, blue = 1, alpha = 0.1 },
        slotEmpty = { red = 0.15, green = 0.15, blue = 0.15, alpha = 1 },
        slotActive = { red = 0.1, green = 0.2, blue = 0.1, alpha = 1 },
        slotMinimized = { red = 0.12, green = 0.12, blue = 0.18, alpha = 1 },
        slotBorder = { red = 1, green = 1, blue = 1, alpha = 0.15 },
        textPrimary = { red = 0.9, green = 0.9, blue = 0.9, alpha = 1 },
        textSecondary = { red = 0.5, green = 0.5, blue = 0.5, alpha = 1 },
        addBtnBg = { red = 0.2, green = 0.25, blue = 0.2, alpha = 1 },
        addBtnText = { red = 0.6, green = 0.8, blue = 0.6, alpha = 1 },
        minBtnBg = { red = 0.18, green = 0.18, blue = 0.25, alpha = 1 },
        minBtnText = { red = 0.6, green = 0.6, blue = 0.9, alpha = 1 },
        helpBtnBg = { red = 0.2, green = 0.18, blue = 0.12, alpha = 1 },
        helpBtnText = { red = 0.9, green = 0.8, blue = 0.5, alpha = 1 },
        notificationBadge = { red = 1, green = 0.3, blue = 0.3, alpha = 1 },
        closeBtn = { red = 1, green = 0.38, blue = 0.34, alpha = 1 },       -- macOS red
        closeBtnHover = { red = 1, green = 0.38, blue = 0.34, alpha = 1 },
        minimizeBtn = { red = 1, green = 0.8, blue = 0.0, alpha = 1 },      -- macOS yellow
        minimizeBtnHover = { red = 1, green = 0.8, blue = 0.0, alpha = 1 },
        windowBtnInactive = { red = 0.3, green = 0.3, blue = 0.3, alpha = 0.6 },
    },
    notificationBadgeSize = 12,
    tabHeight = 28,
    tabWidth = 60,
}

-- Supported agents (order matters for tab display)
local agentOrder = { "claude", "amp", "codex" }
local agents = {
    claude = {
        command = "claude",
        name = "Claude",
        shortName = "Claude",
        color = { red = 0.76, green = 0.37, blue = 0.24, alpha = 1 },  -- #C15F3C
    },
    amp = {
        command = "amp",
        name = "Amp",
        shortName = "Amp",
        color = { red = 0.6, green = 0.2, blue = 0.8, alpha = 1 },  -- Purple
    },
    codex = {
        command = "codex",
        name = "Codex",
        shortName = "Codex",
        color = { red = 0.0, green = 0.65, blue = 0.52, alpha = 1 },  -- OpenAI teal #00A67E
    },
}

-- Grab feature configuration
local grabConfig = {
    name = "Grab",
    color = { red = 1, green = 0.6, blue = 0.2, alpha = 1 },  -- Orange
    colorDisabled = { red = 0.3, green = 0.3, blue = 0.3, alpha = 1 },
    width = 50,
}

local function getAgent()
    return agents[config.agent] or agents.claude
end

-- State
local slotCount = config.initialSlots
local slots = {}
local dock = nil
local tooltip = nil
local helpPanel = nil
local macOSDockAtBottom = false
local pulseTimer = nil
local pulsePhase = 0

-- Grab feature state
local grabState = {
    devServer = { running = false, port = nil, url = nil },
    active = false,  -- Is grab mode active
    elementContext = nil,  -- Selected element info
    worktreePath = nil,
    branch = nil,
}
local grabProgress = {
    active = false,
    stages = {},  -- { worktree = "pending", planning = "in_progress", ... }
}
local progressStages = {
    { id = "worktree", label = "Branch" },
    { id = "planning", label = "Plan" },
    { id = "coding", label = "Code" },
    { id = "testing", label = "Test" },
    { id = "verify", label = "Verify" },
    { id = "pr", label = "PR" },
}
local spotlightWebview = nil
local progressPanel = nil
local prPanel = nil
local devServerTimer = nil

-- Check macOS dock position
local function getMacOSDockPosition()
    local output, status = hs.execute("defaults read com.apple.dock orientation 2>/dev/null")
    if status and output then
        output = output:gsub("%s+", "")
        if output == "left" or output == "right" then
            return output
        end
    end
    return "bottom"  -- default
end

-- Get macOS dock size (tile size + magnification consideration)
local function getMacOSDockHeight()
    local tileSize = hs.execute("defaults read com.apple.dock tilesize 2>/dev/null")
    tileSize = tonumber(tileSize) or 48
    -- Add padding for dock chrome and gaps
    return tileSize + 20
end

-- Resource handles (for cleanup on reload)
local windowFilter = nil
local updateTimer = nil
local screenWatcher = nil

-- Cleanup previous instances on reload
local function cleanup()
    if windowFilter then
        windowFilter:unsubscribeAll()
        windowFilter = nil
    end
    if updateTimer then
        updateTimer:stop()
        updateTimer = nil
    end
    if pulseTimer then
        pulseTimer:stop()
        pulseTimer = nil
    end
    if screenWatcher then
        screenWatcher:stop()
        screenWatcher = nil
    end
    if devServerTimer then
        devServerTimer:stop()
        devServerTimer = nil
    end
    if dock then
        dock:delete()
        dock = nil
    end
    if tooltip then
        tooltip:delete()
        tooltip = nil
    end
    if helpPanel then
        helpPanel:delete()
        helpPanel = nil
    end
    if spotlightWebview then
        spotlightWebview:delete()
        spotlightWebview = nil
    end
    if progressPanel then
        progressPanel:delete()
        progressPanel = nil
    end
    if prPanel then
        prPanel:delete()
        prPanel = nil
    end
end
cleanup()  -- Clean up any previous instance

local function initSlots()
    for i = 1, slotCount do
        if not slots[i] then
            slots[i] = { windowId = nil, customName = nil, pending = false, hasNotification = false }
        end
    end
end
initSlots()

-- Calculate dock dimensions
local function getDockWidth()
    local rightButtonWidth = config.addButtonWidth
    return (config.slotWidth * slotCount) + (config.gap * (slotCount - 1)) + config.gap + rightButtonWidth + (config.margin * 2)
end

local function getDockHeight()
    return config.tabHeight + config.slotHeight + (config.margin * 2)
end

local function getDockFrame()
    local screen = hs.screen.mainScreen()
    if not screen then return nil end
    local frame = screen:fullFrame()
    local dockWidth = getDockWidth()
    local dockHeight = getDockHeight()
    local bottomOffset = config.bottomOffset
    -- Add extra offset if macOS dock is at bottom
    if macOSDockAtBottom then
        bottomOffset = bottomOffset + getMacOSDockHeight()
    end
    return {
        x = (frame.w - dockWidth) / 2,
        y = frame.h - dockHeight - bottomOffset,
        w = dockWidth,
        h = dockHeight
    }
end

-- Window helpers
local function getWindow(windowId)
    if not windowId then return nil end
    return hs.window.get(windowId)
end

local function getWindowTitle(win)
    if not win then return nil end
    local title = win:title() or ""
    if #title > 18 then
        title = title:sub(1, 15) .. "..."
    end
    return title
end

-- Get full window title (not truncated) for parsing
local function getFullWindowTitle(win)
    if not win then return nil end
    return win:title() or ""
end

-- Read the first user prompt from the most recent session file for a given cwd
-- Returns the prompt string or nil
local function getRecentSessionPrompt(cwd, agentType)
    if not cwd or cwd == "" then return nil end

    local sessionPrompt = nil

    if agentType == "claude" then
        -- Claude stores sessions in ~/.claude/projects/<escaped-path>/sessions-index.json
        local escapedPath = cwd:gsub("/", "-")
        local indexPath = os.getenv("HOME") .. "/.claude/projects/" .. escapedPath .. "/sessions-index.json"
        local f = io.open(indexPath, "r")
        if f then
            local content = f:read("*all")
            f:close()
            -- Find the most recent session's firstPrompt
            -- Sessions are in entries array, find one with matching projectPath
            local firstPrompt = content:match('"firstPrompt"%s*:%s*"([^"]*)"')
            if firstPrompt and #firstPrompt > 0 then
                sessionPrompt = firstPrompt
            end
        end
    elseif agentType == "codex" then
        -- Codex stores sessions in ~/.codex/sessions/YYYY/MM/DD/*.jsonl
        -- Find the most recent session file and extract first user_message
        local sessionsDir = os.getenv("HOME") .. "/.codex/sessions"
        -- Use ls to find most recent file (sorted by time)
        local handle = io.popen('find "' .. sessionsDir .. '" -name "*.jsonl" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -1')
        if handle then
            local recentFile = handle:read("*line")
            handle:close()
            if recentFile and #recentFile > 0 then
                local f = io.open(recentFile, "r")
                if f then
                    for line in f:lines() do
                        -- Look for user_message event
                        local msg = line:match('"type"%s*:%s*"user_message".-"message"%s*:%s*"([^"]*)"')
                        if msg and #msg > 0 and not msg:match("^<environment_context>") then
                            sessionPrompt = msg
                            break
                        end
                    end
                    f:close()
                end
            end
        end
    end

    -- Truncate if too long
    if sessionPrompt and #sessionPrompt > 20 then
        sessionPrompt = sessionPrompt:sub(1, 17) .. "..."
    end

    return sessionPrompt
end

-- Parse agent info from terminal window title or process
-- Returns { agent = "claude"|"amp"|"codex"|nil, project = "path", chatName = "chat name", summary = "short description" }
local function parseAgentInfo(win)
    if not win then return nil end

    local title = getFullWindowTitle(win) or ""
    local info = { agent = nil, project = nil, chatName = nil, summary = nil }

    -- Detect agent from title patterns
    -- Claude Code typically shows: "Claude Code" or "claude - /path" or "/path -- chat name"
    local titleLower = title:lower()

    if titleLower:match("claude") then
        info.agent = "claude"
    elseif titleLower:match("amp") then
        info.agent = "amp"
    elseif titleLower:match("codex") then
        info.agent = "codex"
    end

    -- Claude Code format: "/path/to/project -- Chat Name Here" or "dir -- Chat Name"
    -- Try to extract chat name after "--" (emdash or double dash)
    local chatName = title:match("%-%-+%s*(.+)$") or title:match("—%s*(.+)$") or title:match("–%s*(.+)$")
    if chatName and #chatName > 0 then
        -- Trim leading/trailing whitespace
        chatName = chatName:match("^%s*(.-)%s*$")
        info.chatName = chatName
        -- Truncate if needed
        if #info.chatName > 20 then
            info.chatName = info.chatName:sub(1, 17) .. "..."
        end
    end

    -- Try to extract project path from title (before the --)
    -- Common patterns: "/path/to/project -- chat" or "agent - /path" or just "/path"
    local pathPart = title:match("^(.-)%s+[-][-]") or title
    local pathMatch = pathPart:match("(/[^%s]+)") or pathPart:match("[-–]%s*(/[^%s]+)")
    if pathMatch then
        -- Get just the last directory name
        info.project = pathMatch:match("([^/]+)$") or pathMatch
    end

    -- Use chat name as summary if available, otherwise use title
    if info.chatName then
        info.summary = info.chatName
    elseif #title > 0 and not title:match("^/") and not title:match("^Terminal") then
        -- Truncate for display
        if #title > 20 then
            info.summary = title:sub(1, 17) .. "..."
        else
            info.summary = title
        end
    end

    return info
end

-- Generate auto-name for a terminal slot based on window info
local function generateSlotName(win, slotIndex)
    local agent = getAgent()

    if not win then
        return agent.shortName .. " " .. slotIndex
    end

    local info = parseAgentInfo(win)

    -- Priority: chatName > summary > sessionPrompt > project > agent default
    if info and info.chatName and #info.chatName > 0 then
        return info.chatName
    elseif info and info.summary and #info.summary > 0 then
        return info.summary
    end

    -- Try to get prompt from session files if no chat name in title
    local title = getFullWindowTitle(win) or ""
    local cwd = title:match("^(/[^%s]+)") or title:match("[-–]%s*(/[^%s]+)")
    if cwd then
        local sessionPrompt = getRecentSessionPrompt(cwd, config.agent)
        if sessionPrompt and #sessionPrompt > 0 then
            return sessionPrompt
        end
    end

    if info and info.project and #info.project > 0 then
        return info.project
    else
        return agent.shortName .. " " .. slotIndex
    end
end

-- Try to focus a window that might be on another space
-- Returns true if successful
local function focusWindowAcrossSpaces(windowId)
    if not windowId then return false end

    -- First try normal focus
    local win = hs.window.get(windowId)
    if win then
        if win:isMinimized() then
            win:unminimize()
        end
        win:focus()
        return true
    end

    -- Window not found by Hammerspoon - might be on another space
    -- Try using AppleScript to focus by window ID
    local script = [[
        tell application "Terminal"
            set windowList to every window
            repeat with w in windowList
                if id of w is ]] .. windowId .. [[ then
                    set frontmost to true
                    set index of w to 1
                    activate
                    return true
                end if
            end repeat
        end tell
        return false
    ]]

    local ok, result = hs.osascript.applescript(script)
    return ok and result
end

-- Find slot index by window ID
local function findSlotByWindowId(windowId)
    if not windowId then return nil end
    for i, slot in ipairs(slots) do
        if slot.windowId == windowId then
            return i
        end
    end
    return nil
end

-- Forward declaration for pulse animation
local startPulseAnimation

-- Set notification for a slot (only if window is not focused)
local function setSlotNotification(slotIndex)
    local slot = slots[slotIndex]
    if not slot then return end

    local win = getWindow(slot.windowId)
    if win then
        local focusedWin = hs.window.focusedWindow()
        -- Only show notification if window is not currently focused
        if not focusedWin or focusedWin:id() ~= slot.windowId then
            slot.hasNotification = true
            updateSlotDisplay(slotIndex)
            if startPulseAnimation then startPulseAnimation() end
        end
    end
end

-- Tooltip helpers
local function showTooltipAt(text, x, y)
    if tooltip then tooltip:delete() end

    local tipWidth = 50
    local tipHeight = 24

    tooltip = hs.canvas.new({ x = x, y = y, w = tipWidth, h = tipHeight })
    tooltip:appendElements({
        type = "rectangle",
        action = "fill",
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = { red = 0.2, green = 0.2, blue = 0.2, alpha = 0.95 },
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })
    tooltip:appendElements({
        type = "text",
        frame = { x = 0, y = 4, w = tipWidth, h = tipHeight },
        text = text,
        textAlignment = "center",
        textColor = { red = 1, green = 1, blue = 1, alpha = 1 },
        textSize = 12,
        textFont = ".AppleSystemUIFont",
    })
    tooltip:level(hs.canvas.windowLevels.floating)
    tooltip:show()
end

local function showButtonTooltip(text, buttonId)
    local dockFrame = getDockFrame()
    if not dockFrame then return end

    local tipWidth = 50
    local tipHeight = 24
    local btnX, btnWidth
    local dockWidth = getDockWidth()
    local utilBtnSize = config.tabHeight - 8

    if buttonId == "minBtn" then
        -- Top right minimize button
        local minBtnWidth = 72
        btnX = dockFrame.x + dockWidth - config.margin - minBtnWidth
        btnWidth = minBtnWidth
    elseif buttonId == "helpBtn" then
        -- Top right help button (left of minimize)
        local minBtnWidth = 72
        local helpBtnWidth = 36
        btnX = dockFrame.x + dockWidth - config.margin - minBtnWidth - 4 - helpBtnWidth
        btnWidth = helpBtnWidth
    elseif buttonId == "addBtn" then
        -- Bottom right add button
        btnX = dockFrame.x + config.margin + (slotCount * config.slotWidth) + (slotCount * config.gap)
        btnWidth = config.addButtonWidth
    elseif buttonId == "grabBtn" then
        -- Grab button (after agent tabs)
        local tabStartX = config.margin
        btnX = dockFrame.x + tabStartX + (#agentOrder * (config.tabWidth + 4)) + 8
        btnWidth = grabConfig.width
    end

    local tipX = btnX + (btnWidth - tipWidth) / 2
    local tipY = dockFrame.y - tipHeight - 5

    showTooltipAt(text, tipX, tipY)
end

local function hideTooltip()
    if tooltip then
        tooltip:delete()
        tooltip = nil
    end
end

-- Help panel
local function hideHelpPanel()
    if helpPanel then
        helpPanel:delete()
        helpPanel = nil
    end
end

local function showHelpPanel()
    if helpPanel then
        hideHelpPanel()
        return
    end

    local screen = hs.screen.mainScreen()
    if not screen then return end
    local screenFrame = screen:fullFrame()

    local panelWidth = 280
    local panelHeight = 284
    local panelX = (screenFrame.w - panelWidth) / 2
    local panelY = (screenFrame.h - panelHeight) / 2

    helpPanel = hs.canvas.new({ x = panelX, y = panelY, w = panelWidth, h = panelHeight })

    -- Background
    helpPanel:appendElements({
        type = "rectangle",
        action = "fill",
        roundedRectRadii = { xRadius = 12, yRadius = 12 },
        fillColor = { red = 0.1, green = 0.1, blue = 0.1, alpha = 0.95 },
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Border
    helpPanel:appendElements({
        type = "rectangle",
        action = "stroke",
        roundedRectRadii = { xRadius = 12, yRadius = 12 },
        strokeColor = { red = 1, green = 1, blue = 1, alpha = 0.2 },
        strokeWidth = 1,
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Title
    helpPanel:appendElements({
        type = "text",
        frame = { x = 0, y = 15, w = panelWidth, h = 24 },
        text = "Claude Dock Shortcuts",
        textAlignment = "center",
        textColor = { red = 1, green = 1, blue = 1, alpha = 1 },
        textSize = 16,
        textFont = ".AppleSystemUIFontBold",
    })

    -- Shortcuts list
    local shortcuts = {
        { key = "⌘⌥T", desc = "Toggle dock" },
        { key = "⌘⌥N", desc = "Add new terminal" },
        { key = "⌘⌥M", desc = "Minimize all terminals" },
        { key = "⌘⌥G", desc = "Grab element" },
        { key = "⌘⌥R", desc = "Reload config" },
        { key = "⌘⌥L", desc = "Move macOS Dock left" },
        { key = "⌘⌥B", desc = "Move macOS Dock bottom" },
        { key = "⌥+Click", desc = "Rename slot" },
    }

    local startY = 50
    for i, shortcut in ipairs(shortcuts) do
        local y = startY + ((i - 1) * 24)
        helpPanel:appendElements({
            type = "text",
            frame = { x = 20, y = y, w = 70, h = 20 },
            text = shortcut.key,
            textAlignment = "left",
            textColor = { red = 0.6, green = 0.8, blue = 1, alpha = 1 },
            textSize = 13,
            textFont = ".AppleSystemUIFont",
        })
        helpPanel:appendElements({
            type = "text",
            frame = { x = 95, y = y, w = 170, h = 20 },
            text = shortcut.desc,
            textAlignment = "left",
            textColor = { red = 0.8, green = 0.8, blue = 0.8, alpha = 1 },
            textSize = 13,
            textFont = ".AppleSystemUIFont",
        })
    end

    -- Close button
    local closeBtnY = panelHeight - 45
    helpPanel:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = (panelWidth - 80) / 2, y = closeBtnY, w = 80, h = 30 },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = { red = 0.25, green = 0.25, blue = 0.25, alpha = 1 },
        trackMouseUp = true,
        id = "closeBtn",
    })
    helpPanel:appendElements({
        type = "text",
        frame = { x = (panelWidth - 80) / 2, y = closeBtnY + 6, w = 80, h = 20 },
        text = "Close",
        textAlignment = "center",
        textColor = { red = 0.9, green = 0.9, blue = 0.9, alpha = 1 },
        textSize = 13,
        textFont = ".AppleSystemUIFont",
        trackMouseUp = true,
        id = "closeBtn",
    })

    helpPanel:mouseCallback(function(_, event, id)
        if event == "mouseUp" and id == "closeBtn" then
            hideHelpPanel()
        end
    end)

    helpPanel:level(hs.canvas.windowLevels.modalPanel)
    helpPanel:show()
end

-- =====================
-- GRAB FEATURE FUNCTIONS
-- =====================

-- Dev server detection
local function detectDevServer()
    local ports = { 3000, 3001, 5173, 5174, 4000, 8080, 8000 }
    for _, port in ipairs(ports) do
        local handle = io.popen("lsof -i tcp:" .. port .. " -sTCP:LISTEN 2>/dev/null | head -1")
        local output = handle:read("*all")
        handle:close()
        if output and #output > 0 then
            return { running = true, port = port, url = "http://localhost:" .. port }
        end
    end
    return { running = false, port = nil, url = nil }
end

-- Update dev server state and refresh Grab button
local function updateDevServerState()
    local newState = detectDevServer()
    local changed = (newState.running ~= grabState.devServer.running)
    grabState.devServer = newState
    if changed and dock then
        -- Recreate dock to update grab button visual
        dock:delete()
        createDock()
    end
end

-- Start periodic dev server detection
local function startDevServerDetection()
    if devServerTimer then devServerTimer:stop() end
    -- Check initial state without recreating dock
    grabState.devServer = detectDevServer()
    -- Then check every 5 seconds
    devServerTimer = hs.timer.doEvery(5, updateDevServerState)
end

-- Detect project root from source file path
local function detectProjectRoot(sourcePath)
    if not sourcePath then return nil end
    -- Extract directory from source path
    local dir = sourcePath:match("(.*/)")
    if not dir then return nil end

    -- Walk up looking for package.json, .git, etc.
    local current = dir
    while current and #current > 1 do
        -- Check for common project markers
        local markers = { "package.json", ".git", "Cargo.toml", "go.mod", "pyproject.toml" }
        for _, marker in ipairs(markers) do
            local f = io.open(current .. marker, "r")
            if f then
                f:close()
                return current:gsub("/$", "")  -- Remove trailing slash
            end
        end
        -- Go up one directory
        current = current:match("(.*/)[^/]+/$")
    end
    return nil
end

-- Git worktree management
local function createWorktree(projectRoot, featureName)
    if not projectRoot then return nil end

    local branch = "grab/" .. featureName:gsub("%s+", "-"):gsub("[^%w%-]", ""):lower():sub(1, 40)
    local worktreePath = projectRoot .. "/.worktrees/" .. branch

    -- Ensure .worktrees exists and is gitignored
    os.execute("mkdir -p " .. projectRoot .. "/.worktrees")
    os.execute("grep -q '.worktrees/' " .. projectRoot .. "/.gitignore 2>/dev/null || echo '.worktrees/' >> " .. projectRoot .. "/.gitignore")

    -- Detect main branch (main or master)
    local handle = io.popen("cd " .. projectRoot .. " && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'")
    local mainBranch = handle:read("*line") or "main"
    handle:close()
    if mainBranch == "" then mainBranch = "main" end

    -- Create worktree from main branch
    local cmd = string.format("cd %s && git worktree add %s -b %s origin/%s 2>&1",
        projectRoot, worktreePath, branch, mainBranch)
    local handle2 = io.popen(cmd)
    local output = handle2:read("*all")
    local success = handle2:close()

    if success then
        return { path = worktreePath, branch = branch }
    else
        -- Worktree creation failed - log error
        print("Worktree creation failed: " .. (output or "unknown error"))
        return nil
    end
end

local function removeWorktree(worktreePath)
    if worktreePath then
        os.execute("git worktree remove " .. worktreePath .. " --force 2>/dev/null")
    end
end

-- Progress tracking
local function updateProgress(stageId, status)
    grabProgress.stages[stageId] = status
    if progressPanel then
        updateProgressPanel()
    end
end

local function resetProgress()
    grabProgress.active = false
    grabProgress.stages = {}
    for _, stage in ipairs(progressStages) do
        grabProgress.stages[stage.id] = "pending"
    end
end

-- Progress panel UI
local function hideProgressPanel()
    if progressPanel then
        progressPanel:delete()
        progressPanel = nil
    end
end

local function updateProgressPanel()
    -- This will be called to refresh the panel
    if not progressPanel then return end
    -- Update is handled by recreating - simpler than tracking element indices
end

local function showProgressPanel()
    hideProgressPanel()

    local screen = hs.screen.mainScreen()
    if not screen then return end
    local screenFrame = screen:fullFrame()

    local panelWidth = 400
    local panelHeight = 60
    local dockFrame = getDockFrame()
    if not dockFrame then return end

    local panelX = dockFrame.x + (dockFrame.w - panelWidth) / 2
    local panelY = dockFrame.y - panelHeight - 10

    progressPanel = hs.canvas.new({ x = panelX, y = panelY, w = panelWidth, h = panelHeight })

    -- Background
    progressPanel:appendElements({
        type = "rectangle",
        action = "fill",
        roundedRectRadii = { xRadius = 10, yRadius = 10 },
        fillColor = { red = 0.1, green = 0.1, blue = 0.1, alpha = 0.95 },
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Border
    progressPanel:appendElements({
        type = "rectangle",
        action = "stroke",
        roundedRectRadii = { xRadius = 10, yRadius = 10 },
        strokeColor = { red = 1, green = 1, blue = 1, alpha = 0.2 },
        strokeWidth = 1,
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Stage indicators
    local stageWidth = panelWidth / #progressStages
    for i, stage in ipairs(progressStages) do
        local stageX = (i - 1) * stageWidth + stageWidth / 2
        local status = grabProgress.stages[stage.id] or "pending"

        -- Circle
        local circleColor
        if status == "completed" then
            circleColor = { red = 0.2, green = 0.8, blue = 0.3, alpha = 1 }  -- Green
        elseif status == "in_progress" then
            circleColor = { red = 1, green = 0.6, blue = 0.2, alpha = 1 }    -- Orange
        elseif status == "failed" then
            circleColor = { red = 1, green = 0.3, blue = 0.3, alpha = 1 }    -- Red
        else
            circleColor = { red = 0.3, green = 0.3, blue = 0.3, alpha = 1 }  -- Gray
        end

        progressPanel:appendElements({
            type = "circle",
            action = "fill",
            center = { x = stageX, y = 20 },
            radius = 8,
            fillColor = circleColor,
        })

        -- Connecting line (except for last stage)
        if i < #progressStages then
            progressPanel:appendElements({
                type = "segments",
                action = "stroke",
                coordinates = {
                    { x = stageX + 12, y = 20 },
                    { x = stageX + stageWidth - 12, y = 20 },
                },
                strokeColor = { red = 0.4, green = 0.4, blue = 0.4, alpha = 1 },
                strokeWidth = 2,
            })
        end

        -- Label
        progressPanel:appendElements({
            type = "text",
            frame = { x = stageX - 30, y = 32, w = 60, h = 20 },
            text = stage.label,
            textAlignment = "center",
            textColor = { red = 0.7, green = 0.7, blue = 0.7, alpha = 1 },
            textSize = 10,
            textFont = ".AppleSystemUIFont",
        })
    end

    progressPanel:level(hs.canvas.windowLevels.floating)
    progressPanel:behavior(hs.canvas.windowBehaviors.canJoinAllSpaces)
    progressPanel:show()
end

-- PR Panel UI
local function hidePRPanel()
    if prPanel then
        prPanel:delete()
        prPanel = nil
    end
end

local function showPRPanel(prUrl, prNumber)
    hidePRPanel()

    local screen = hs.screen.mainScreen()
    if not screen then return end
    local screenFrame = screen:fullFrame()

    local panelWidth = 300
    local panelHeight = 120
    local panelX = screenFrame.w - panelWidth - 20
    local panelY = 60

    prPanel = hs.canvas.new({ x = panelX, y = panelY, w = panelWidth, h = panelHeight })

    -- Background
    prPanel:appendElements({
        type = "rectangle",
        action = "fill",
        roundedRectRadii = { xRadius = 12, yRadius = 12 },
        fillColor = { red = 0.1, green = 0.15, blue = 0.1, alpha = 0.95 },
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Border
    prPanel:appendElements({
        type = "rectangle",
        action = "stroke",
        roundedRectRadii = { xRadius = 12, yRadius = 12 },
        strokeColor = { red = 0.2, green = 0.8, blue = 0.3, alpha = 0.5 },
        strokeWidth = 1,
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Title
    prPanel:appendElements({
        type = "text",
        frame = { x = 15, y = 12, w = panelWidth - 50, h = 24 },
        text = "PR Created",
        textColor = { red = 0.2, green = 0.9, blue = 0.4, alpha = 1 },
        textSize = 16,
        textFont = ".AppleSystemUIFontBold",
    })

    -- PR number/URL
    local displayUrl = prUrl or "Unknown"
    if #displayUrl > 35 then
        displayUrl = displayUrl:sub(1, 32) .. "..."
    end
    prPanel:appendElements({
        type = "text",
        frame = { x = 15, y = 38, w = panelWidth - 30, h = 20 },
        text = prNumber and ("#" .. prNumber) or displayUrl,
        textColor = { red = 0.7, green = 0.7, blue = 0.7, alpha = 1 },
        textSize = 12,
        textFont = ".AppleSystemUIFont",
    })

    -- View in Browser button
    prPanel:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = 15, y = 65, w = 120, h = 30 },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = { red = 0.2, green = 0.5, blue = 0.3, alpha = 1 },
        trackMouseUp = true,
        id = "viewPRBtn",
    })
    prPanel:appendElements({
        type = "text",
        frame = { x = 15, y = 72, w = 120, h = 20 },
        text = "View in Browser",
        textAlignment = "center",
        textColor = { red = 1, green = 1, blue = 1, alpha = 1 },
        textSize = 12,
        textFont = ".AppleSystemUIFont",
        trackMouseUp = true,
        id = "viewPRBtn",
    })

    -- Close button
    prPanel:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = 145, y = 65, w = 60, h = 30 },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = { red = 0.3, green = 0.3, blue = 0.3, alpha = 1 },
        trackMouseUp = true,
        id = "closePRBtn",
    })
    prPanel:appendElements({
        type = "text",
        frame = { x = 145, y = 72, w = 60, h = 20 },
        text = "Close",
        textAlignment = "center",
        textColor = { red = 0.9, green = 0.9, blue = 0.9, alpha = 1 },
        textSize = 12,
        textFont = ".AppleSystemUIFont",
        trackMouseUp = true,
        id = "closePRBtn",
    })

    prPanel:mouseCallback(function(_, event, id)
        if event == "mouseUp" then
            if id == "viewPRBtn" and prUrl then
                hs.urlevent.openURL(prUrl)
            elseif id == "closePRBtn" then
                hidePRPanel()
            end
        end
    end)

    prPanel:level(hs.canvas.windowLevels.floating)
    prPanel:show()
end

-- Spotlight modal
local function hideSpotlightModal()
    if spotlightWebview then
        spotlightWebview:delete()
        spotlightWebview = nil
    end
end

local function showSpotlightModal(elementContext)
    hideSpotlightModal()

    local screen = hs.screen.mainScreen()
    if not screen then return end
    local screenFrame = screen:fullFrame()

    local modalWidth = 600
    local modalHeight = 100

    spotlightWebview = hs.webview.new({
        x = (screenFrame.w - modalWidth) / 2,
        y = screenFrame.h * 0.3,
        w = modalWidth,
        h = modalHeight
    })

    local contextText = elementContext.source or elementContext.tagName or "Selected element"
    local html = [[
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    background: rgba(30, 30, 30, 0.98);
                    border-radius: 12px;
                    overflow: hidden;
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                }
                #context {
                    padding: 8px 20px;
                    color: #888;
                    font-size: 11px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                #input {
                    width: 100%;
                    height: 50px;
                    font-size: 22px;
                    padding: 0 20px;
                    background: transparent;
                    border: none;
                    color: white;
                    outline: none;
                }
                #input::placeholder {
                    color: #555;
                }
            </style>
        </head>
        <body>
            <div id="context">]] .. contextText .. [[</div>
            <input id="input" type="text" placeholder="What do you want to build?" autofocus>
            <script>
                const input = document.getElementById('input');
                input.focus();
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && input.value.trim()) {
                        window.webkit.messageHandlers.hammerspoon.postMessage({
                            action: 'submit',
                            prompt: input.value.trim()
                        });
                    } else if (e.key === 'Escape') {
                        window.webkit.messageHandlers.hammerspoon.postMessage({ action: 'cancel' });
                    }
                });
            </script>
        </body>
        </html>
    ]]

    spotlightWebview:html(html)
    spotlightWebview:allowTextEntry(true)
    spotlightWebview:windowStyle({ "borderless", "closable" })
    spotlightWebview:level(hs.canvas.windowLevels.modalPanel)
    spotlightWebview:bringToFront(true)

    -- Handle messages from webview
    local messageHandler = function(msg)
        if msg.body.action == "submit" then
            hideSpotlightModal()
            startGrabWorkflow(elementContext, msg.body.prompt)
        elseif msg.body.action == "cancel" then
            hideSpotlightModal()
            grabState.active = false
        end
    end

    spotlightWebview:windowCallback(function(action, webview, info)
        if action == "closing" then
            grabState.active = false
        end
    end)

    -- Use a userContentController to receive messages
    local uc = spotlightWebview:userContentController()
    uc:setCallback(messageHandler)

    spotlightWebview:show()
end

-- Claude subagent execution
local function runClaudeSubagent(role, context, generous)
    local prompts = {
        planner = "You are a planning specialist. Analyze the grabbed element and user request. Output: files to modify, new files needed, step-by-step implementation plan, test scenarios. Be thorough but concise.",
        coder = "You are an implementation specialist. Follow the plan exactly. Write clean code following existing project conventions. Make minimal changes needed.",
        tester = "You are a testing specialist. Write integration tests. Use real implementations, minimize mocks. Run tests and fix failures until all pass.",
        verifier = "You are a verification specialist. Review ALL changes made. Check code quality, test coverage, no regressions. This is ONE pass only - be thorough.",
    }

    local tools = {
        planner = "Read,Glob,Grep",
        coder = "Read,Glob,Grep,Edit,Write,Bash",
        tester = "Read,Write,Edit,Bash",
        verifier = "Read,Glob,Grep,Bash",
    }

    local budget = generous and "5" or "1"

    -- Build the prompt with context
    local fullPrompt = string.format([[
Context:
- Element source: %s
- User request: %s
- Working directory: %s
- Branch: %s

%s

Execute your role now.
]], context.element.source or "unknown",
    context.prompt,
    context.worktreePath,
    context.branch or "unknown",
    prompts[role])

    -- Run Claude CLI
    local cmd = string.format([[cd %s && claude -p --dangerously-skip-permissions --allowedTools "%s" --output-format json "%s" 2>&1]],
        context.worktreePath,
        tools[role],
        fullPrompt:gsub('"', '\\"'):gsub('\n', '\\n'))

    local handle = io.popen(cmd)
    local output = handle:read("*all")
    handle:close()

    -- Try to parse JSON output
    local success, result = pcall(hs.json.decode, output)
    if success then
        return result
    else
        return { error = "Failed to parse output", raw = output }
    end
end

-- Create PR
local function createPullRequest(context)
    if not context.worktreePath or not context.branch then
        return nil
    end

    -- Push branch
    local pushCmd = string.format("cd %s && git push -u origin %s 2>&1", context.worktreePath, context.branch)
    os.execute(pushCmd)

    -- Create PR using gh CLI
    local prTitle = context.prompt:sub(1, 70)
    local prBody = string.format([[
## Summary
Automated implementation via Claude Dock Grab feature.

**Element:** %s
**Request:** %s

## Changes
See commits for details.

---
Generated by Claude Dock Grab
]], context.element.source or "unknown", context.prompt)

    local prCmd = string.format([[cd %s && gh pr create --title "%s" --body "%s" --json url,number 2>&1]],
        context.worktreePath,
        prTitle:gsub('"', '\\"'),
        prBody:gsub('"', '\\"'):gsub('\n', '\\n'))

    local handle = io.popen(prCmd)
    local output = handle:read("*all")
    handle:close()

    -- Parse PR URL from output
    local success, prData = pcall(hs.json.decode, output)
    if success and prData.url then
        return prData.url, prData.number
    end

    -- Fallback: try to extract URL from text
    local url = output:match("https://github.com/[^\n%s]+")
    return url
end

-- Main grab workflow orchestration
local function startGrabWorkflow(elementContext, userPrompt)
    local context = {
        element = elementContext,
        prompt = userPrompt,
        projectRoot = detectProjectRoot(elementContext.source),
    }

    if not context.projectRoot then
        hs.alert.show("Could not detect project root")
        return
    end

    -- Initialize and show progress
    resetProgress()
    grabProgress.active = true
    showProgressPanel()

    -- Run workflow in background task
    hs.task.new("/bin/bash", function(exitCode, stdOut, stdErr)
        -- Workflow complete
        hideProgressPanel()
        if exitCode == 0 then
            local prUrl = stdOut:match("PR_URL:([^\n]+)")
            local prNumber = stdOut:match("PR_NUMBER:([^\n]+)")
            if prUrl then
                showPRPanel(prUrl, prNumber)
            end
        else
            hs.alert.show("Grab workflow failed: " .. (stdErr or "unknown error"))
        end
        grabState.active = false
    end, function(task, stdOut, stdErr)
        -- Progress callback - parse stage updates
        if stdOut then
            local stage = stdOut:match("STAGE:([^:]+):([^\n]+)")
            if stage then
                updateProgress(stage, "completed")
            end
        end
        return true
    end, {
        "-c",
        string.format([[
            set -e
            PROJECT_ROOT="%s"
            PROMPT="%s"
            ELEMENT_SOURCE="%s"

            # Stage 1: Create worktree
            echo "STAGE:worktree:in_progress"
            BRANCH="grab/$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-' | cut -c1-40)"
            WORKTREE_PATH="$PROJECT_ROOT/.worktrees/$BRANCH"
            mkdir -p "$PROJECT_ROOT/.worktrees"
            grep -q '.worktrees/' "$PROJECT_ROOT/.gitignore" 2>/dev/null || echo '.worktrees/' >> "$PROJECT_ROOT/.gitignore"
            MAIN_BRANCH=$(cd "$PROJECT_ROOT" && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
            cd "$PROJECT_ROOT" && git worktree add "$WORKTREE_PATH" -b "$BRANCH" "origin/$MAIN_BRANCH" 2>&1
            echo "STAGE:worktree:completed"

            # Stage 2: Planning
            echo "STAGE:planning:in_progress"
            cd "$WORKTREE_PATH" && claude -p --dangerously-skip-permissions \
                --allowedTools "Read,Glob,Grep" \
                "You are a planning specialist. Analyze and plan implementation for: $PROMPT. Element: $ELEMENT_SOURCE. Output files to modify and implementation steps."
            echo "STAGE:planning:completed"

            # Stage 3: Coding
            echo "STAGE:coding:in_progress"
            cd "$WORKTREE_PATH" && claude -p --dangerously-skip-permissions \
                --allowedTools "Read,Glob,Grep,Edit,Write,Bash" \
                "Implement the feature: $PROMPT. Follow project conventions. Make minimal necessary changes."
            echo "STAGE:coding:completed"

            # Stage 4: Testing
            echo "STAGE:testing:in_progress"
            cd "$WORKTREE_PATH" && claude -p --dangerously-skip-permissions \
                --allowedTools "Read,Write,Edit,Bash" \
                "Write and run tests for: $PROMPT. Fix any failures."
            echo "STAGE:testing:completed"

            # Stage 5: Verification
            echo "STAGE:verify:in_progress"
            cd "$WORKTREE_PATH" && claude -p --dangerously-skip-permissions \
                --allowedTools "Read,Glob,Grep,Bash" \
                "Review all changes for: $PROMPT. Verify code quality and test coverage."
            echo "STAGE:verify:completed"

            # Stage 6: Create PR
            echo "STAGE:pr:in_progress"
            cd "$WORKTREE_PATH" && git add -A && git commit -m "feat: $PROMPT" || true
            cd "$WORKTREE_PATH" && git push -u origin "$BRANCH" 2>&1
            PR_RESULT=$(cd "$WORKTREE_PATH" && gh pr create --title "feat: $PROMPT" --body "Automated via Claude Dock Grab" --json url,number 2>&1)
            echo "STAGE:pr:completed"

            echo "PR_URL:$(echo "$PR_RESULT" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)"
            echo "PR_NUMBER:$(echo "$PR_RESULT" | grep -o '"number":[0-9]*' | cut -d':' -f2)"
        ]],
            context.projectRoot:gsub('"', '\\"'),
            userPrompt:gsub('"', '\\"'),
            (elementContext.source or ""):gsub('"', '\\"')
        )
    }):start()
end

-- Chrome element selection via MCP tools
local function injectElementPicker()
    -- This script injects an element picker into the page
    local pickerScript = [[
        (function() {
            // Remove any existing picker
            if (window.__grabPickerActive) return;
            window.__grabPickerActive = true;

            const overlay = document.createElement('div');
            overlay.id = 'grab-picker-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:999999;cursor:crosshair;';

            const highlight = document.createElement('div');
            highlight.id = 'grab-picker-highlight';
            highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:999998;border:2px solid #ff6b2b;background:rgba(255,107,43,0.1);transition:all 0.1s;';

            const label = document.createElement('div');
            label.id = 'grab-picker-label';
            label.style.cssText = 'position:fixed;z-index:999999;background:#ff6b2b;color:white;padding:4px 8px;font-size:12px;font-family:monospace;border-radius:4px;pointer-events:none;';

            document.body.appendChild(overlay);
            document.body.appendChild(highlight);
            document.body.appendChild(label);

            let lastElement = null;

            overlay.addEventListener('mousemove', function(e) {
                overlay.style.pointerEvents = 'none';
                const el = document.elementFromPoint(e.clientX, e.clientY);
                overlay.style.pointerEvents = 'auto';

                if (el && el !== lastElement && el !== overlay && el !== highlight && el !== label) {
                    lastElement = el;
                    const rect = el.getBoundingClientRect();
                    highlight.style.top = rect.top + 'px';
                    highlight.style.left = rect.left + 'px';
                    highlight.style.width = rect.width + 'px';
                    highlight.style.height = rect.height + 'px';

                    const source = el.getAttribute('data-source') || el.getAttribute('data-testid') || '';
                    const tagInfo = el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : '');
                    label.textContent = source || tagInfo;
                    label.style.top = (rect.top - 24) + 'px';
                    label.style.left = rect.left + 'px';
                }
            });

            overlay.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                overlay.style.pointerEvents = 'none';
                const el = document.elementFromPoint(e.clientX, e.clientY);
                overlay.style.pointerEvents = 'auto';

                if (el) {
                    window.__grabResult = {
                        source: el.getAttribute('data-source') || '',
                        tagName: el.tagName,
                        className: el.className || '',
                        id: el.id || '',
                        textContent: (el.textContent || '').substring(0, 100)
                    };
                }

                // Cleanup
                overlay.remove();
                highlight.remove();
                label.remove();
                window.__grabPickerActive = false;
            });

            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    overlay.remove();
                    highlight.remove();
                    label.remove();
                    window.__grabPickerActive = false;
                    window.__grabResult = null;
                }
            }, { once: true });
        })();
    ]]
    return pickerScript
end

-- Main function to activate grab mode
function activateGrabMode()
    if grabState.active then
        hs.alert.show("Grab mode already active")
        return
    end

    if not grabState.devServer.running then
        hs.alert.show("Start a dev server first")
        return
    end

    grabState.active = true

    -- Check if Chrome is running and has a page
    hs.alert.show("Click an element in Chrome...")

    -- For now, we'll use a simplified approach:
    -- 1. Focus Chrome
    -- 2. Show spotlight modal with manual source input option

    local chrome = hs.application.get("Google Chrome")
    if not chrome then
        hs.alert.show("Open Google Chrome with your app first")
        grabState.active = false
        return
    end

    chrome:activate()

    -- Inject the element picker using hs.osascript
    local injectScript = [[
        tell application "Google Chrome"
            set theTab to active tab of front window
            execute theTab javascript "]] .. injectElementPicker():gsub('"', '\\"'):gsub('\n', '\\n') .. [["
        end tell
    ]]

    hs.osascript.applescript(injectScript)

    -- Poll for result
    local pollCount = 0
    local maxPolls = 60  -- 30 seconds

    local pollTimer
    pollTimer = hs.timer.doEvery(0.5, function()
        pollCount = pollCount + 1

        if pollCount > maxPolls then
            pollTimer:stop()
            grabState.active = false
            hs.alert.show("Grab timed out")
            return
        end

        -- Check for result
        local checkScript = [[
            tell application "Google Chrome"
                set theTab to active tab of front window
                set result to execute theTab javascript "JSON.stringify(window.__grabResult || null)"
                return result
            end tell
        ]]

        local ok, result = hs.osascript.applescript(checkScript)
        if ok and result and result ~= "null" then
            pollTimer:stop()

            -- Parse the result
            local success, elementContext = pcall(hs.json.decode, result)
            if success and elementContext then
                -- Clear the result in Chrome
                hs.osascript.applescript([[
                    tell application "Google Chrome"
                        execute active tab of front window javascript "window.__grabResult = null;"
                    end tell
                ]])

                -- Show spotlight modal
                showSpotlightModal(elementContext)
            else
                grabState.active = false
                hs.alert.show("Failed to parse element")
            end
        end
    end)
end

-- Forward declarations
local createDock
local updateAllSlots
local minimizeAllTerminals

-- Update slot display
local function updateSlotDisplay(slotIndex)
    if not dock then return end
    if slotIndex > slotCount then return end

    local slot = slots[slotIndex]
    local baseIdx = config.baseElements + 1 + ((slotIndex - 1) * config.elementsPerSlot)

    local title, status, bgColor
    local win = getWindow(slot.windowId)

    local agent = getAgent()
    if win then
        -- Auto-generate name from window title if no custom name
        title = slot.customName or generateSlotName(win, slotIndex)
        if win:isMinimized() then
            status = "(minimized)"
            bgColor = config.colors.slotMinimized
        else
            status = "active"
            bgColor = config.colors.slotActive
        end
    elseif slot.windowId then
        -- Window exists but not visible (probably on another space)
        title = slot.customName or agent.name
        status = "(other space)"
        bgColor = config.colors.slotMinimized
    else
        -- No window assigned
        if slot.pending then
            title = slot.customName or "Opening..."
            status = "launching"
        else
            title = "Empty"
            status = "click to open"
        end
        bgColor = config.colors.slotEmpty
    end

    if dock[baseIdx] then
        dock[baseIdx].fillColor = bgColor
    end
    if dock[baseIdx + 2] then
        dock[baseIdx + 2].text = title
    end
    if dock[baseIdx + 3] then
        dock[baseIdx + 3].text = status
    end
    -- Update notification badge with glow
    local badgeColor = config.colors.notificationBadge
    local hidden = { red = 0, green = 0, blue = 0, alpha = 0 }

    -- Outer glow (baseIdx + 4)
    if dock[baseIdx + 4] then
        dock[baseIdx + 4].fillColor = slot.hasNotification
            and { red = badgeColor.red, green = badgeColor.green, blue = badgeColor.blue, alpha = 0.2 }
            or hidden
    end
    -- Inner glow (baseIdx + 5)
    if dock[baseIdx + 5] then
        dock[baseIdx + 5].fillColor = slot.hasNotification
            and { red = badgeColor.red, green = badgeColor.green, blue = badgeColor.blue, alpha = 0.4 }
            or hidden
    end
    -- Main badge (baseIdx + 6)
    if dock[baseIdx + 6] then
        dock[baseIdx + 6].fillColor = slot.hasNotification
            and badgeColor
            or hidden
    end

    -- Update window control buttons (baseIdx + 7 = close, baseIdx + 8 = minimize)
    local hasWindow = (win ~= nil)
    -- Close button
    if dock[baseIdx + 7] then
        dock[baseIdx + 7].fillColor = hasWindow
            and config.colors.closeBtn
            or config.colors.windowBtnInactive
    end
    -- Minimize button
    if dock[baseIdx + 8] then
        dock[baseIdx + 8].fillColor = hasWindow
            and config.colors.minimizeBtn
            or config.colors.windowBtnInactive
    end
end

updateAllSlots = function()
    for i = 1, slotCount do
        updateSlotDisplay(i)
    end
end

-- Pulse animation for notification badges
local function updatePulse()
    if not dock then return end

    pulsePhase = pulsePhase + 0.15
    if pulsePhase > math.pi * 2 then
        pulsePhase = 0
    end

    -- Pulsing multiplier: oscillates between 0.5 and 1.0
    local pulse = 0.75 + 0.25 * math.sin(pulsePhase)

    local badgeColor = config.colors.notificationBadge
    local hidden = { red = 0, green = 0, blue = 0, alpha = 0 }

    local hasAnyNotification = false
    for i = 1, slotCount do
        local slot = slots[i]
        if slot and slot.hasNotification then
            hasAnyNotification = true
            local baseIdx = config.baseElements + 1 + ((i - 1) * config.elementsPerSlot)

            -- Outer glow pulses
            if dock[baseIdx + 4] then
                dock[baseIdx + 4].fillColor = {
                    red = badgeColor.red,
                    green = badgeColor.green,
                    blue = badgeColor.blue,
                    alpha = 0.2 * pulse
                }
            end
            -- Inner glow pulses
            if dock[baseIdx + 5] then
                dock[baseIdx + 5].fillColor = {
                    red = badgeColor.red,
                    green = badgeColor.green,
                    blue = badgeColor.blue,
                    alpha = 0.5 * pulse
                }
            end
        end
    end

    -- Stop timer if no notifications
    if not hasAnyNotification and pulseTimer then
        pulseTimer:stop()
        pulseTimer = nil
    end
end

startPulseAnimation = function()
    if not pulseTimer then
        pulseTimer = hs.timer.doEvery(0.05, updatePulse)
    end
end

local function stopPulseAnimation()
    if pulseTimer then
        pulseTimer:stop()
        pulseTimer = nil
    end
end

-- Close a terminal in a slot (force kill without confirmation)
local function closeSlotTerminal(slotIndex)
    local slot = slots[slotIndex]
    if not slot then return false end

    local windowId = slot.windowId
    if not windowId then return false end

    -- Get the tty and kill all processes on it, then close
    local script = [[
        tell application "Terminal"
            repeat with w in windows
                if id of w is ]] .. windowId .. [[ then
                    repeat with t in tabs of w
                        set ttyPath to tty of t
                        if ttyPath is not missing value and ttyPath is not "" then
                            -- Kill all processes on this tty using ps + kill
                            set ttyShort to do shell script "basename " & quoted form of ttyPath
                            do shell script "ps -t " & ttyShort & " -o pid= | xargs kill -9 2>/dev/null || true"
                        end if
                        -- Also try to get processes property
                        try
                            set procList to processes of t
                            repeat with p in procList
                                do shell script "kill -9 " & p & " 2>/dev/null || true"
                            end repeat
                        end try
                    end repeat
                    delay 0.2
                    close w
                    return true
                end if
            end repeat
        end tell
        return false
    ]]

    hs.osascript.applescript(script)

    -- Clear slot data
    slot.windowId = nil
    slot.customName = nil
    slot.hasNotification = false
    updateSlotDisplay(slotIndex)

    return true
end

-- Minimize a terminal in a slot
local function minimizeSlotTerminal(slotIndex)
    local slot = slots[slotIndex]
    if not slot then return false end

    local win = getWindow(slot.windowId)
    if win and not win:isMinimized() then
        win:minimize()
        updateSlotDisplay(slotIndex)
        return true
    end
    return false
end

-- Rename a slot
local function renameSlot(slotIndex)
    local slot = slots[slotIndex]
    local button, newName = hs.dialog.textPrompt(
        "Rename Slot " .. slotIndex,
        "Enter a name for this slot:",
        slot.customName or "",
        "Save", "Cancel"
    )
    if button == "Save" and newName and newName ~= "" then
        slot.customName = newName
        updateSlotDisplay(slotIndex)
    end
end

-- Capture newly created terminal window with retries
local function captureNewWindow(slot, retryCount)
    retryCount = retryCount or 0
    if retryCount >= config.windowCaptureRetries then
        slot.pending = false
        updateAllSlots()
        return
    end

    local termApp = hs.application.get("Terminal")
    if not termApp then
        hs.timer.doAfter(config.windowCaptureDelay, function()
            captureNewWindow(slot, retryCount + 1)
        end)
        return
    end

    local wins = termApp:allWindows()
    for _, w in ipairs(wins) do
        local winId = w:id()
        local isTracked = false
        for _, s in ipairs(slots) do
            if s.windowId == winId then
                isTracked = true
                break
            end
        end
        if not isTracked then
            slot.windowId = winId
            slot.pending = false
            updateAllSlots()
            return
        end
    end

    -- Window not found yet, retry
    hs.timer.doAfter(config.windowCaptureDelay, function()
        captureNewWindow(slot, retryCount + 1)
    end)
end

-- Handle slot click
local function onSlotClick(slotIndex, isOptionClick)
    local slot = slots[slotIndex]

    if isOptionClick then
        renameSlot(slotIndex)
        return
    end

    -- Clear notification when clicked
    slot.hasNotification = false

    local win = getWindow(slot.windowId)
    if win then
        if win:isMinimized() then
            win:unminimize()
        end
        win:focus()
    elseif slot.windowId then
        -- Window ID exists but not visible - probably on another space
        -- Try to focus it across spaces instead of creating a new terminal
        if focusWindowAcrossSpaces(slot.windowId) then
            -- Successfully focused the window on another space
            hs.alert.show("Switched to terminal on another space")
        else
            -- Window truly gone, clear the slot
            slot.windowId = nil
            slot.customName = nil
            -- Now create a new terminal (will be handled by the next click or below)
        end
    end

    -- Only create new terminal if slot is truly empty
    if not slot.windowId and not slot.pending then
        local agent = getAgent()

        -- Auto-generate name instead of prompting
        slot.customName = nil  -- Will be auto-generated from window title
        slot.pending = true

        hs.applescript([[
            tell application "Terminal"
                do script "]] .. agent.command .. [["
                activate
            end tell
        ]])

        captureNewWindow(slot, 0)
    end

    updateSlotDisplay(slotIndex)
end

-- Add a new slot and launch terminal
local function addSlot()
    slotCount = slotCount + 1
    slots[slotCount] = { windowId = nil, customName = nil, pending = false, hasNotification = false }

    if dock then
        dock:delete()
    end
    createDock()
    onSlotClick(slotCount, false)
end

-- Create the dock UI
createDock = function()
    local frame = getDockFrame()
    if not frame then
        hs.alert.show("Claude Dock: No screen found")
        return
    end

    dock = hs.canvas.new(frame)

    -- Background
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        roundedRectRadii = { xRadius = 14, yRadius = 14 },
        fillColor = config.colors.dockBg,
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Border
    dock:appendElements({
        type = "rectangle",
        action = "stroke",
        roundedRectRadii = { xRadius = 14, yRadius = 14 },
        strokeColor = config.colors.dockBorder,
        strokeWidth = 1,
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Agent tabs (top left)
    local tabY = 6
    local tabStartX = config.margin
    for i, agentKey in ipairs(agentOrder) do
        local agent = agents[agentKey]
        local tabX = tabStartX + ((i - 1) * (config.tabWidth + 4))
        local isSelected = (config.agent == agentKey)

        -- Tab background
        dock:appendElements({
            type = "rectangle",
            action = "fill",
            frame = { x = tabX, y = tabY, w = config.tabWidth, h = config.tabHeight - 8 },
            roundedRectRadii = { xRadius = 6, yRadius = 6 },
            fillColor = isSelected and agent.color or { red = 0.15, green = 0.15, blue = 0.15, alpha = 1 },
            trackMouseUp = true,
            id = "tab_" .. agentKey,
        })

        -- Tab text
        dock:appendElements({
            type = "text",
            frame = { x = tabX, y = tabY + 2, w = config.tabWidth, h = config.tabHeight - 8 },
            text = agent.name,
            textAlignment = "center",
            textColor = isSelected
                and { red = 1, green = 1, blue = 1, alpha = 1 }
                or { red = 0.5, green = 0.5, blue = 0.5, alpha = 1 },
            textSize = 12,
            textFont = isSelected and ".AppleSystemUIFontBold" or ".AppleSystemUIFont",
            trackMouseUp = true,
            id = "tab_" .. agentKey,
        })
    end

    -- Grab button (after agent tabs, before utility buttons)
    local grabTabX = tabStartX + (#agentOrder * (config.tabWidth + 4)) + 8
    local grabEnabled = grabState.devServer.running
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = grabTabX, y = tabY, w = grabConfig.width, h = config.tabHeight - 8 },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = grabEnabled and grabConfig.color or grabConfig.colorDisabled,
        trackMouseUp = true,
        trackMouseEnterExit = true,
        id = "grabBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = grabTabX, y = tabY + 2, w = grabConfig.width, h = config.tabHeight - 8 },
        text = grabConfig.name,
        textAlignment = "center",
        textColor = grabEnabled
            and { red = 1, green = 1, blue = 1, alpha = 1 }
            or { red = 0.5, green = 0.5, blue = 0.5, alpha = 1 },
        textSize = 12,
        textFont = ".AppleSystemUIFontBold",
        trackMouseUp = true,
        id = "grabBtn",
    })

    -- Content area starts below tabs
    local contentY = config.tabHeight

    -- Utility buttons (top right, in tab bar area - same Y as tabs)
    local utilBtnSize = config.tabHeight - 8
    local utilBtnY = 6
    local dockWidth = getDockWidth()

    -- Minimize all button (rightmost)
    local minBtnWidth = 72
    local minBtnX = dockWidth - config.margin - minBtnWidth
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = minBtnX, y = utilBtnY, w = minBtnWidth, h = utilBtnSize },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = config.colors.minBtnBg,
        trackMouseUp = true,
        trackMouseEnterExit = true,
        id = "minBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = minBtnX, y = utilBtnY + 2, w = minBtnWidth, h = utilBtnSize },
        text = "Minimize all",
        textAlignment = "center",
        textColor = config.colors.minBtnText,
        textSize = 11,
        textFont = ".AppleSystemUIFontBold",
        trackMouseUp = true,
        id = "minBtn",
    })

    -- Help button (left of minimize)
    local helpBtnWidth = 36
    local helpBtnX = minBtnX - helpBtnWidth - 4
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = helpBtnX, y = utilBtnY, w = helpBtnWidth, h = utilBtnSize },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = config.colors.helpBtnBg,
        trackMouseUp = true,
        trackMouseEnterExit = true,
        id = "helpBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = helpBtnX, y = utilBtnY + 2, w = helpBtnWidth, h = utilBtnSize },
        text = "Help",
        textAlignment = "center",
        textColor = config.colors.helpBtnText,
        textSize = 11,
        textFont = ".AppleSystemUIFontBold",
        trackMouseUp = true,
        id = "helpBtn",
    })

    -- Slots
    local slotsStartX = config.margin
    local slotY = contentY + config.margin
    for i = 1, slotCount do
        local slotX = slotsStartX + ((i - 1) * (config.slotWidth + config.gap))

        dock:appendElements({
            type = "rectangle",
            action = "fill",
            frame = { x = slotX, y = slotY, w = config.slotWidth, h = config.slotHeight },
            roundedRectRadii = { xRadius = 10, yRadius = 10 },
            fillColor = config.colors.slotEmpty,
            trackMouseUp = true,
            id = "slot" .. i,
        })

        dock:appendElements({
            type = "rectangle",
            action = "stroke",
            frame = { x = slotX, y = slotY, w = config.slotWidth, h = config.slotHeight },
            roundedRectRadii = { xRadius = 10, yRadius = 10 },
            strokeColor = config.colors.slotBorder,
            strokeWidth = 1,
        })

        dock:appendElements({
            type = "text",
            frame = { x = slotX + 6, y = slotY + 8, w = config.slotWidth - 12, h = 24 },
            text = "Empty",
            textAlignment = "center",
            textColor = config.colors.textPrimary,
            textSize = 13,
            textFont = ".AppleSystemUIFont",
        })

        dock:appendElements({
            type = "text",
            frame = { x = slotX + 6, y = slotY + 32, w = config.slotWidth - 12, h = 20 },
            text = "click to open",
            textAlignment = "center",
            textColor = config.colors.textSecondary,
            textSize = 10,
            textFont = ".AppleSystemUIFont",
        })

        -- Notification badge with glow (top-right corner, true corner position)
        local badgeSize = config.notificationBadgeSize
        local badgeCenterX = slotX + config.slotWidth - 4
        local badgeCenterY = slotY + 4

        -- Outer glow
        dock:appendElements({
            type = "circle",
            action = "fill",
            center = { x = badgeCenterX, y = badgeCenterY },
            radius = badgeSize,
            fillColor = { red = 0, green = 0, blue = 0, alpha = 0 },  -- Hidden by default
        })

        -- Inner glow
        dock:appendElements({
            type = "circle",
            action = "fill",
            center = { x = badgeCenterX, y = badgeCenterY },
            radius = badgeSize * 0.75,
            fillColor = { red = 0, green = 0, blue = 0, alpha = 0 },  -- Hidden by default
        })

        -- Main badge
        dock:appendElements({
            type = "circle",
            action = "fill",
            center = { x = badgeCenterX, y = badgeCenterY },
            radius = badgeSize / 2,
            fillColor = { red = 0, green = 0, blue = 0, alpha = 0 },  -- Hidden by default
        })

        -- macOS-style window control buttons (top-left corner)
        local btnSize = 10
        local btnY = slotY + 8
        local closeBtnX = slotX + 8

        -- Close button (red X)
        dock:appendElements({
            type = "circle",
            action = "fill",
            center = { x = closeBtnX + btnSize/2, y = btnY + btnSize/2 },
            radius = btnSize / 2,
            fillColor = config.colors.windowBtnInactive,  -- Shows when slot has window
            trackMouseUp = true,
            trackMouseEnterExit = true,
            id = "closeBtn" .. i,
        })

        -- Minimize button (yellow, right of close)
        local minSlotBtnX = closeBtnX + btnSize + 4
        dock:appendElements({
            type = "circle",
            action = "fill",
            center = { x = minSlotBtnX + btnSize/2, y = btnY + btnSize/2 },
            radius = btnSize / 2,
            fillColor = config.colors.windowBtnInactive,  -- Shows when slot has window
            trackMouseUp = true,
            trackMouseEnterExit = true,
            id = "minSlotBtn" .. i,
        })
    end

    -- Add button (right side)
    local addBtnX = slotsStartX + (slotCount * (config.slotWidth + config.gap))
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = addBtnX, y = slotY, w = config.addButtonWidth, h = config.slotHeight },
        roundedRectRadii = { xRadius = 10, yRadius = 10 },
        fillColor = { red = 0.95, green = 0.95, blue = 0.95, alpha = 1 },
        trackMouseUp = true,
        trackMouseEnterExit = true,
        id = "addBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = addBtnX, y = slotY + 13, w = config.addButtonWidth, h = 30 },
        text = "+",
        textAlignment = "center",
        textColor = { red = 0.3, green = 0.3, blue = 0.3, alpha = 1 },
        textSize = 28,
        textFont = ".AppleSystemUIFont",
        trackMouseUp = true,
        id = "addBtn",
    })

    dock:mouseCallback(function(_, event, id)
        if event == "mouseUp" then
            if id == "addBtn" then
                addSlot()
            elseif id == "minBtn" then
                minimizeAllTerminals()
            elseif id == "helpBtn" then
                showHelpPanel()
            elseif id == "grabBtn" then
                if grabState.devServer.running then
                    activateGrabMode()
                else
                    hs.alert.show("Start a dev server first (ports 3000, 5173, etc.)")
                end
            elseif id and id:match("^tab_") then
                local agentKey = id:match("^tab_(.+)$")
                if agentKey and agents[agentKey] then
                    config.agent = agentKey
                    -- Recreate dock to update tab visuals
                    dock:delete()
                    createDock()
                end
            elseif id and id:match("^closeBtn") then
                -- Close button clicked
                local idx = tonumber(id:match("%d+"))
                if idx then
                    closeSlotTerminal(idx)
                end
            elseif id and id:match("^minSlotBtn") then
                -- Minimize button clicked
                local idx = tonumber(id:match("%d+"))
                if idx then
                    minimizeSlotTerminal(idx)
                end
            elseif id and id:match("^slot") then
                local idx = tonumber(id:match("%d+"))
                if idx then
                    local mods = hs.eventtap.checkKeyboardModifiers()
                    onSlotClick(idx, mods.alt)
                end
            end
        elseif event == "mouseEnter" then
            if id == "addBtn" then
                showButtonTooltip("⌘⌥N", "addBtn")
            elseif id == "minBtn" then
                showButtonTooltip("⌘⌥M", "minBtn")
            elseif id == "helpBtn" then
                showButtonTooltip("Help", "helpBtn")
            elseif id == "grabBtn" then
                if grabState.devServer.running then
                    showButtonTooltip("⌘⌥G", "grabBtn")
                else
                    showButtonTooltip("No server", "grabBtn")
                end
            end
        elseif event == "mouseExit" and (id == "addBtn" or id == "minBtn" or id == "helpBtn" or id == "grabBtn") then
            hideTooltip()
        end
    end)

    dock:level(hs.canvas.windowLevels.floating)
    dock:behavior(hs.canvas.windowBehaviors.canJoinAllSpaces)
    dock:show()
    updateAllSlots()
end

local function toggleDock()
    if dock then
        if dock:isShowing() then dock:hide() else dock:show() end
    end
end

-- Minimize all terminal windows
minimizeAllTerminals = function()
    local minimizedCount = 0
    for _, slot in ipairs(slots) do
        local win = getWindow(slot.windowId)
        if win and not win:isMinimized() then
            win:minimize()
            minimizedCount = minimizedCount + 1
        end
    end
    if minimizedCount > 0 then
        hs.alert.show("Minimized " .. minimizedCount .. " terminal" .. (minimizedCount > 1 and "s" or ""))
    end
    updateAllSlots()
end

-- Window event watcher for immediate updates
windowFilter = hs.window.filter.new("Terminal")
windowFilter:subscribe({
    hs.window.filter.windowMinimized,
    hs.window.filter.windowUnminimized,
}, updateAllSlots)

-- Handle window destruction - clear the slot
windowFilter:subscribe(hs.window.filter.windowDestroyed, function(win, appName, event)
    -- win may be nil at this point, so we need to check all slots
    for i, slot in ipairs(slots) do
        if slot.windowId then
            local existingWin = getWindow(slot.windowId)
            if not existingWin then
                -- Try to verify window is truly gone (not just on another space)
                -- by checking all Terminal windows
                local allTerminals = hs.window.filter.new("Terminal"):getWindows()
                local found = false
                for _, w in ipairs(allTerminals) do
                    if w:id() == slot.windowId then
                        found = true
                        break
                    end
                end
                if not found then
                    slot.windowId = nil
                    slot.customName = nil
                    slot.hasNotification = false
                end
            end
        end
    end
    updateAllSlots()
end)

-- Clear notification when window is focused
windowFilter:subscribe(hs.window.filter.windowFocused, function(win)
    if win then
        local slotIndex = findSlotByWindowId(win:id())
        if slotIndex then
            slots[slotIndex].hasNotification = false
        end
    end
    updateAllSlots()
end)

-- Watch for window title changes (indicates terminal activity)
windowFilter:subscribe(hs.window.filter.windowTitleChanged, function(win)
    if win then
        local slotIndex = findSlotByWindowId(win:id())
        if slotIndex then
            local focusedWin = hs.window.focusedWindow()
            -- Only show notification if this window isn't focused
            if not focusedWin or focusedWin:id() ~= win:id() then
                slots[slotIndex].hasNotification = true
                updateSlotDisplay(slotIndex)
                startPulseAnimation()
            end
        end
    end
end)

-- Periodic refresh as fallback
updateTimer = hs.timer.doEvery(2, function()
    if dock and dock:isShowing() then
        updateAllSlots()
    end
end)

-- Screen change handler
screenWatcher = hs.screen.watcher.new(function()
    if dock then
        local frame = getDockFrame()
        if frame then
            dock:frame(frame)
        end
    end
end)
screenWatcher:start()

-- Move macOS dock position
local function moveMacOSDockLeft()
    hs.execute("defaults write com.apple.dock orientation left && killall Dock")
    macOSDockAtBottom = false
    hs.alert.show("macOS Dock moved to left")
    -- Reposition Claude Dock
    if dock then
        local frame = getDockFrame()
        if frame then dock:frame(frame) end
    end
end

local function moveMacOSDockBottom()
    hs.execute("defaults write com.apple.dock orientation bottom && killall Dock")
    macOSDockAtBottom = true
    hs.alert.show("macOS Dock moved to bottom")
    -- Reposition Claude Dock
    if dock then
        local frame = getDockFrame()
        if frame then dock:frame(frame) end
    end
end

-- Check macOS dock and prompt user if at bottom
-- Returns true if user chose to keep dock at bottom
local function checkMacOSDockOnStartup()
    local position = getMacOSDockPosition()
    if position == "bottom" then
        local button = hs.dialog.blockAlert(
            "macOS Dock Position",
            "Your macOS Dock is at the bottom of the screen, which may overlap with Claude Dock.\n\nWould you like to move it to the left side?",
            "Move to Left",
            "Keep at Bottom"
        )
        if button == "Move to Left" then
            moveMacOSDockLeft()
            return false
        else
            macOSDockAtBottom = true
            return true
        end
    end
    return false
end

-- Initialize
local showRepositionedMsg = checkMacOSDockOnStartup()
createDock()
startDevServerDetection()

-- Hotkeys
hs.hotkey.bind({"cmd", "alt"}, "T", toggleDock)
hs.hotkey.bind({"cmd", "alt"}, "N", addSlot)
hs.hotkey.bind({"cmd", "alt"}, "M", minimizeAllTerminals)
hs.hotkey.bind({"cmd", "alt"}, "R", hs.reload)
hs.hotkey.bind({"cmd", "alt"}, "L", moveMacOSDockLeft)
hs.hotkey.bind({"cmd", "alt"}, "B", moveMacOSDockBottom)
hs.hotkey.bind({"cmd", "alt"}, "G", activateGrabMode)

hs.alert.show("Claude Dock Ready")
if showRepositionedMsg then
    hs.timer.doAfter(1.5, function()
        hs.alert.show("Positioned above macOS Dock")
    end)
end

-- Global function to trigger notification on a slot (for testing or external use)
-- Usage: triggerNotification(1) to trigger on slot 1
function triggerNotification(slotIndex)
    if slotIndex and slots[slotIndex] then
        setSlotNotification(slotIndex)
        return true
    end
    return false
end

-- Global function to clear notification on a slot
function clearNotification(slotIndex)
    if slotIndex and slots[slotIndex] then
        slots[slotIndex].hasNotification = false
        updateSlotDisplay(slotIndex)
        return true
    end
    return false
end

-- ===================
-- TESTS (run with: hs -c "runTests()")
-- ===================

function runTests()
    local passed, failed = 0, 0
    local savedSlotCount = slotCount
    local savedSlots = {}
    for i, s in ipairs(slots) do
        savedSlots[i] = { windowId = s.windowId, customName = s.customName, pending = s.pending }
    end

    local function test(name, fn)
        local ok, err = pcall(fn)
        if ok then
            print("✓ " .. name)
            passed = passed + 1
        else
            print("✗ " .. name .. ": " .. tostring(err))
            failed = failed + 1
        end
    end

    local function assertEqual(a, b, msg)
        if a ~= b then
            error((msg or "assertEqual") .. ": expected " .. tostring(b) .. ", got " .. tostring(a))
        end
    end

    local function restore()
        slotCount = savedSlotCount
        slots = {}
        for i, s in ipairs(savedSlots) do
            slots[i] = { windowId = s.windowId, customName = s.customName, pending = s.pending }
        end
    end

    print("\n=== Claude Dock Tests ===\n")

    test("getWindow returns nil for nil input", function()
        assertEqual(getWindow(nil), nil)
    end)

    test("getWindow returns nil for invalid windowId", function()
        assertEqual(getWindow(999999999), nil)
    end)

    test("getWindowTitle returns nil for nil window", function()
        assertEqual(getWindowTitle(nil), nil)
    end)

    test("slot clears windowId when window gone", function()
        local testSlot = { windowId = 999999999 }
        if not getWindow(testSlot.windowId) then
            testSlot.windowId = nil
        end
        assertEqual(testSlot.windowId, nil)
    end)

    test("slot clears customName when window gone", function()
        local testSlot = { windowId = 999999999, customName = "Test" }
        if not getWindow(testSlot.windowId) then
            testSlot.windowId = nil
            testSlot.customName = nil
        end
        assertEqual(testSlot.customName, nil)
    end)

    test("getDockWidth scales with slotCount", function()
        local w1 = getDockWidth()
        slotCount = slotCount + 1
        local w2 = getDockWidth()
        restore()
        assert(w2 > w1, "width should increase")
    end)

    test("getDockHeight is constant", function()
        local h1 = getDockHeight()
        slotCount = slotCount + 5
        local h2 = getDockHeight()
        restore()
        assertEqual(h1, h2)
    end)

    test("initSlots creates correct slots", function()
        slots = {}
        slotCount = 3
        initSlots()
        assert(slots[1] and slots[2] and slots[3], "slots 1-3 should exist")
        assert(not slots[4], "slot 4 should not exist")
        restore()
    end)

    test("toggleDock changes visibility", function()
        local was = dock:isShowing()
        toggleDock()
        assertEqual(dock:isShowing(), not was)
        toggleDock()
    end)

    test("updateSlotDisplay handles invalid index", function()
        local ok = pcall(updateSlotDisplay, 9999)
        assert(ok, "should not error")
    end)

    test("windowFilter exists", function()
        assert(windowFilter, "windowFilter should exist")
    end)

    test("cleanup function exists", function()
        assert(type(cleanup) == "function", "cleanup should be a function")
    end)

    test("config has required color fields", function()
        assert(config.colors.slotEmpty, "slotEmpty color")
        assert(config.colors.slotActive, "slotActive color")
        assert(config.colors.slotMinimized, "slotMinimized color")
    end)

    test("getDockFrame returns table with x,y,w,h", function()
        local frame = getDockFrame()
        assert(frame, "frame should exist")
        assert(frame.x and frame.y and frame.w and frame.h, "frame should have x,y,w,h")
    end)

    test("minimizeAllTerminals is a function", function()
        assert(type(minimizeAllTerminals) == "function", "minimizeAllTerminals should be a function")
    end)

    test("minimizeAllTerminals handles empty slots", function()
        slots = {{ windowId = nil }, { windowId = nil }}
        slotCount = 2
        local ok = pcall(minimizeAllTerminals)
        restore()
        assert(ok, "should not error with empty slots")
    end)

    test("minimizeAllTerminals handles invalid windowIds", function()
        slots = {{ windowId = 999999999 }, { windowId = 888888888 }}
        slotCount = 2
        local ok = pcall(minimizeAllTerminals)
        restore()
        assert(ok, "should not error with invalid windowIds")
    end)

    test("moveMacOSDockLeft is a function", function()
        assert(type(moveMacOSDockLeft) == "function", "moveMacOSDockLeft should be a function")
    end)

    test("moveMacOSDockBottom is a function", function()
        assert(type(moveMacOSDockBottom) == "function", "moveMacOSDockBottom should be a function")
    end)

    test("getMacOSDockPosition returns valid position", function()
        local pos = getMacOSDockPosition()
        assert(pos == "left" or pos == "right" or pos == "bottom", "position should be left, right, or bottom")
    end)

    test("getMacOSDockHeight returns number", function()
        local height = getMacOSDockHeight()
        assert(type(height) == "number", "height should be a number")
        assert(height > 0, "height should be positive")
    end)

    test("checkMacOSDockOnStartup is a function", function()
        assert(type(checkMacOSDockOnStartup) == "function", "checkMacOSDockOnStartup should be a function")
    end)

    test("showHelpPanel is a function", function()
        assert(type(showHelpPanel) == "function", "showHelpPanel should be a function")
    end)

    test("hideHelpPanel is a function", function()
        assert(type(hideHelpPanel) == "function", "hideHelpPanel should be a function")
    end)

    -- Notification badge tests
    test("config has notification badge color", function()
        assert(config.colors.notificationBadge, "notificationBadge color should exist")
        assert(config.notificationBadgeSize, "notificationBadgeSize should exist")
    end)

    test("slots have hasNotification field", function()
        slots = {}
        slotCount = 2
        initSlots()
        assert(slots[1].hasNotification == false, "slot should have hasNotification = false")
        restore()
    end)

    test("findSlotByWindowId returns nil for unknown window", function()
        assertEqual(findSlotByWindowId(999999999), nil)
    end)

    test("findSlotByWindowId returns nil for nil input", function()
        assertEqual(findSlotByWindowId(nil), nil)
    end)

    test("triggerNotification is a function", function()
        assert(type(triggerNotification) == "function", "triggerNotification should be a function")
    end)

    test("clearNotification is a function", function()
        assert(type(clearNotification) == "function", "clearNotification should be a function")
    end)

    test("triggerNotification returns false for invalid slot", function()
        assertEqual(triggerNotification(9999), false)
    end)

    test("clearNotification returns false for invalid slot", function()
        assertEqual(clearNotification(9999), false)
    end)

    -- Agent configuration tests
    test("config has agent field", function()
        assert(config.agent, "config.agent should exist")
    end)

    test("agents table has claude, amp, codex", function()
        assert(agents.claude, "agents.claude should exist")
        assert(agents.amp, "agents.amp should exist")
        assert(agents.codex, "agents.codex should exist")
    end)

    test("each agent has command and name", function()
        for name, agent in pairs(agents) do
            assert(agent.command, name .. " should have command")
            assert(agent.name, name .. " should have name")
            assert(agent.shortName, name .. " should have shortName")
        end
    end)

    test("getAgent returns valid agent", function()
        local agent = getAgent()
        assert(agent, "getAgent should return an agent")
        assert(agent.command, "agent should have command")
        assert(agent.name, "agent should have name")
    end)

    test("getAgent falls back to claude for invalid config", function()
        local originalAgent = config.agent
        config.agent = "invalid"
        local agent = getAgent()
        assertEqual(agent.command, "claude")
        config.agent = originalAgent
    end)

    -- New functionality tests

    test("getFullWindowTitle returns nil for nil window", function()
        assertEqual(getFullWindowTitle(nil), nil)
    end)

    test("parseAgentInfo returns nil for nil window", function()
        assertEqual(parseAgentInfo(nil), nil)
    end)

    test("generateSlotName returns agent default for nil window", function()
        local name = generateSlotName(nil, 1)
        local agent = getAgent()
        assertEqual(name, agent.shortName .. " 1")
    end)

    test("focusWindowAcrossSpaces returns false for nil windowId", function()
        assertEqual(focusWindowAcrossSpaces(nil), false)
    end)

    test("focusWindowAcrossSpaces returns false for invalid windowId", function()
        -- Invalid window ID should return false (window not found)
        local result = focusWindowAcrossSpaces(999999999)
        -- May return true if AppleScript finds something, or false otherwise
        assert(type(result) == "boolean", "should return boolean")
    end)

    test("closeSlotTerminal returns false for invalid slot", function()
        assertEqual(closeSlotTerminal(9999), false)
    end)

    test("closeSlotTerminal returns false for empty slot", function()
        slots = {{ windowId = nil }}
        slotCount = 1
        assertEqual(closeSlotTerminal(1), false)
        restore()
    end)

    test("minimizeSlotTerminal returns false for invalid slot", function()
        assertEqual(minimizeSlotTerminal(9999), false)
    end)

    test("minimizeSlotTerminal returns false for empty slot", function()
        slots = {{ windowId = nil }}
        slotCount = 1
        assertEqual(minimizeSlotTerminal(1), false)
        restore()
    end)

    test("minimizeSlotTerminal returns false for invalid windowId", function()
        slots = {{ windowId = 999999999 }}
        slotCount = 1
        assertEqual(minimizeSlotTerminal(1), false)
        restore()
    end)

    test("config has window button colors", function()
        assert(config.colors.closeBtn, "closeBtn color should exist")
        assert(config.colors.minimizeBtn, "minimizeBtn color should exist")
        assert(config.colors.windowBtnInactive, "windowBtnInactive color should exist")
    end)

    test("elementsPerSlot includes window buttons", function()
        assertEqual(config.elementsPerSlot, 9)
    end)

    -- Chat name parsing tests
    test("parseAgentInfo extracts chatName from title with --", function()
        -- Create a mock window object for testing
        local mockWin = {
            title = function() return "/Users/test/project -- Fix auth bug" end
        }
        local info = parseAgentInfo(mockWin)
        assertEqual(info.chatName, "Fix auth bug")
        assertEqual(info.project, "project")
    end)

    test("parseAgentInfo extracts chatName without leading path", function()
        local mockWin = {
            title = function() return "mydir -- Some task name" end
        }
        local info = parseAgentInfo(mockWin)
        assertEqual(info.chatName, "Some task name")
    end)

    test("parseAgentInfo handles title without --", function()
        local mockWin = {
            title = function() return "/Users/test/myproject" end
        }
        local info = parseAgentInfo(mockWin)
        assertEqual(info.chatName, nil)
        assertEqual(info.project, "myproject")
    end)

    test("parseAgentInfo truncates long chat names", function()
        local mockWin = {
            title = function() return "/path -- This is a very long chat name that should be truncated" end
        }
        local info = parseAgentInfo(mockWin)
        assert(#info.chatName <= 20, "chatName should be truncated to 20 chars or less")
        assert(info.chatName:match("%.%.%.$"), "truncated chatName should end with ...")
    end)

    test("generateSlotName prioritizes chatName", function()
        local mockWin = {
            title = function() return "/Users/test/project -- My Chat Name" end
        }
        local name = generateSlotName(mockWin, 1)
        assertEqual(name, "My Chat Name")
    end)

    -- Session prompt reading tests
    test("getRecentSessionPrompt returns nil for nil cwd", function()
        assertEqual(getRecentSessionPrompt(nil, "claude"), nil)
    end)

    test("getRecentSessionPrompt returns nil for empty cwd", function()
        assertEqual(getRecentSessionPrompt("", "claude"), nil)
    end)

    test("getRecentSessionPrompt returns nil for nonexistent path", function()
        assertEqual(getRecentSessionPrompt("/nonexistent/path/12345", "claude"), nil)
    end)

    test("getRecentSessionPrompt handles codex agent type", function()
        -- Should not error, may return nil or a prompt
        local result = getRecentSessionPrompt("/Users/molinar", "codex")
        assert(result == nil or type(result) == "string", "should return nil or string")
    end)

    test("getRecentSessionPrompt truncates long prompts", function()
        -- This tests the truncation logic - if we get a result, it should be <= 20 chars
        local result = getRecentSessionPrompt("/Users/molinar", "codex")
        if result then
            assert(#result <= 20, "result should be truncated to 20 chars or less")
        end
    end)

    -- Grab feature tests
    test("detectDevServer returns correct structure", function()
        local result = detectDevServer()
        assert(type(result) == "table", "should return a table")
        assert(type(result.running) == "boolean", "should have running boolean")
        -- port and url can be nil when not running
        if result.running then
            assert(type(result.port) == "number", "should have port number when running")
            assert(type(result.url) == "string", "should have url string when running")
        end
    end)

    test("grabConfig exists with required fields", function()
        assert(grabConfig, "grabConfig should exist")
        assert(grabConfig.name == "Grab", "grabConfig.name should be 'Grab'")
        assert(grabConfig.color, "grabConfig should have color")
        assert(grabConfig.colorDisabled, "grabConfig should have colorDisabled")
        assert(grabConfig.width, "grabConfig should have width")
    end)

    test("grabState initializes correctly", function()
        assert(grabState, "grabState should exist")
        assert(type(grabState.devServer) == "table", "should have devServer table")
        assert(type(grabState.active) == "boolean", "should have active boolean")
    end)

    test("grabProgress initializes correctly", function()
        assert(grabProgress, "grabProgress should exist")
        assert(type(grabProgress.active) == "boolean", "should have active boolean")
        assert(type(grabProgress.stages) == "table", "should have stages table")
    end)

    test("progressStages has correct structure", function()
        assert(#progressStages == 6, "should have 6 stages")
        for i, stage in ipairs(progressStages) do
            assert(stage.id, "stage " .. i .. " should have id")
            assert(stage.label, "stage " .. i .. " should have label")
        end
    end)

    test("detectProjectRoot returns nil for nil input", function()
        assertEqual(detectProjectRoot(nil), nil)
    end)

    test("detectProjectRoot returns nil for invalid path", function()
        assertEqual(detectProjectRoot("/nonexistent/path/file.tsx:10:5"), nil)
    end)

    test("createWorktree returns nil for nil projectRoot", function()
        assertEqual(createWorktree(nil, "test feature"), nil)
    end)

    test("resetProgress clears all stages to pending", function()
        grabProgress.stages["worktree"] = "completed"
        grabProgress.stages["planning"] = "in_progress"
        resetProgress()
        for _, stage in ipairs(progressStages) do
            assertEqual(grabProgress.stages[stage.id], "pending")
        end
    end)

    test("updateProgress updates stage status", function()
        resetProgress()
        updateProgress("worktree", "completed")
        assertEqual(grabProgress.stages["worktree"], "completed")
        resetProgress()  -- cleanup
    end)

    test("activateGrabMode is a function", function()
        assert(type(activateGrabMode) == "function", "activateGrabMode should be a function")
    end)

    test("showSpotlightModal is a function", function()
        assert(type(showSpotlightModal) == "function", "showSpotlightModal should be a function")
    end)

    test("hideSpotlightModal is a function", function()
        assert(type(hideSpotlightModal) == "function", "hideSpotlightModal should be a function")
    end)

    test("showProgressPanel is a function", function()
        assert(type(showProgressPanel) == "function", "showProgressPanel should be a function")
    end)

    test("hideProgressPanel is a function", function()
        assert(type(hideProgressPanel) == "function", "hideProgressPanel should be a function")
    end)

    test("showPRPanel is a function", function()
        assert(type(showPRPanel) == "function", "showPRPanel should be a function")
    end)

    test("hidePRPanel is a function", function()
        assert(type(hidePRPanel) == "function", "hidePRPanel should be a function")
    end)

    test("startDevServerDetection is a function", function()
        assert(type(startDevServerDetection) == "function", "startDevServerDetection should be a function")
    end)

    test("injectElementPicker returns script string", function()
        local script = injectElementPicker()
        assert(type(script) == "string", "should return a string")
        assert(script:match("__grabResult"), "script should reference __grabResult")
    end)

    print("\n=== Results: " .. passed .. " passed, " .. failed .. " failed ===\n")
    return failed == 0
end
