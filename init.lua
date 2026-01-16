-- Claude Dock: Terminal dock for managing Claude Code sessions
-- https://github.com/YOUR_USERNAME/claude-dock

require("hs.ipc")

-- Configuration
local config = {
    slotWidth = 140,
    slotHeight = 60,
    gap = 8,
    margin = 10,
    bottomOffset = 5,
    addButtonWidth = 40,
    utilityButtonWidth = 28,
    initialSlots = 3,
    elementsPerSlot = 5,  -- bg, border, title, status, notification badge
    baseElements = 6,     -- dock bg + border + help btn + help text + minimize btn + minimize text
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
    },
    notificationBadgeSize = 12,
}

-- State
local slotCount = config.initialSlots
local slots = {}
local dock = nil
local tooltip = nil
local helpPanel = nil
local macOSDockAtBottom = false

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
    if screenWatcher then
        screenWatcher:stop()
        screenWatcher = nil
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
    -- Left: small utility button (minimize), Right: add button
    local leftButtonWidth = config.utilityButtonWidth + config.gap
    local rightButtonWidth = config.addButtonWidth
    return leftButtonWidth + (config.slotWidth * slotCount) + (config.gap * (slotCount - 1)) + config.gap + rightButtonWidth + (config.margin * 2)
end

local function getDockHeight()
    return config.slotHeight + (config.margin * 2)
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

    if buttonId == "minBtn" or buttonId == "helpBtn" then
        -- Left side utility buttons
        btnX = dockFrame.x + config.margin
        btnWidth = config.utilityButtonWidth
    elseif buttonId == "addBtn" then
        -- Right side add button
        btnX = dockFrame.x + config.margin + config.utilityButtonWidth + config.gap + (slotCount * config.slotWidth) + (slotCount * config.gap)
        btnWidth = config.addButtonWidth
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
    local panelHeight = 260
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

    if win then
        title = slot.customName or getWindowTitle(win) or "Terminal"
        if win:isMinimized() then
            status = "(minimized)"
            bgColor = config.colors.slotMinimized
        else
            status = "active"
            bgColor = config.colors.slotActive
        end
    else
        -- Don't clear customName if we're waiting for a window to spawn
        if not slot.pending then
            slot.windowId = nil
            slot.customName = nil
            slot.hasNotification = false
            title = "Empty"
            status = "click to open"
        else
            title = slot.customName or "Opening..."
            status = "launching"
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
    -- Update notification badge visibility
    if dock[baseIdx + 4] then
        dock[baseIdx + 4].fillColor = slot.hasNotification
            and config.colors.notificationBadge
            or { red = 0, green = 0, blue = 0, alpha = 0 }
    end
end

updateAllSlots = function()
    for i = 1, slotCount do
        updateSlotDisplay(i)
    end
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
    else
        local button, newName = hs.dialog.textPrompt(
            "New Claude Terminal",
            "Enter a name for this terminal:",
            "Claude " .. slotIndex,
            "Create", "Cancel"
        )

        if button ~= "Create" then
            return
        end

        slot.customName = (newName and newName ~= "") and newName or ("Claude " .. slotIndex)
        slot.pending = true

        hs.applescript([[
            tell application "Terminal"
                do script "claude"
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

    -- Utility buttons (left side, stacked: help on top, minimize on bottom)
    local utilBtnX = config.margin
    local btnGap = 4
    local btnHeight = (config.slotHeight - btnGap) / 2

    -- Help button (top)
    local helpBtnY = config.margin
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = utilBtnX, y = helpBtnY, w = config.utilityButtonWidth, h = btnHeight },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = config.colors.helpBtnBg,
        trackMouseUp = true,
        trackMouseEnterExit = true,
        id = "helpBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = utilBtnX, y = helpBtnY + 4, w = config.utilityButtonWidth, h = btnHeight },
        text = "?",
        textAlignment = "center",
        textColor = config.colors.helpBtnText,
        textSize = 16,
        textFont = ".AppleSystemUIFontBold",
        trackMouseUp = true,
        id = "helpBtn",
    })

    -- Minimize button (bottom)
    local minBtnY = config.margin + btnHeight + btnGap
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = utilBtnX, y = minBtnY, w = config.utilityButtonWidth, h = btnHeight },
        roundedRectRadii = { xRadius = 6, yRadius = 6 },
        fillColor = config.colors.minBtnBg,
        trackMouseUp = true,
        trackMouseEnterExit = true,
        id = "minBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = utilBtnX, y = minBtnY + 4, w = config.utilityButtonWidth, h = btnHeight },
        text = "⌄",
        textAlignment = "center",
        textColor = config.colors.minBtnText,
        textSize = 16,
        textFont = ".AppleSystemUIFont",
        trackMouseUp = true,
        id = "minBtn",
    })

    -- Slots (offset by utility button)
    local slotsStartX = config.margin + config.utilityButtonWidth + config.gap
    for i = 1, slotCount do
        local slotX = slotsStartX + ((i - 1) * (config.slotWidth + config.gap))

        dock:appendElements({
            type = "rectangle",
            action = "fill",
            frame = { x = slotX, y = config.margin, w = config.slotWidth, h = config.slotHeight },
            roundedRectRadii = { xRadius = 10, yRadius = 10 },
            fillColor = config.colors.slotEmpty,
            trackMouseUp = true,
            id = "slot" .. i,
        })

        dock:appendElements({
            type = "rectangle",
            action = "stroke",
            frame = { x = slotX, y = config.margin, w = config.slotWidth, h = config.slotHeight },
            roundedRectRadii = { xRadius = 10, yRadius = 10 },
            strokeColor = config.colors.slotBorder,
            strokeWidth = 1,
        })

        dock:appendElements({
            type = "text",
            frame = { x = slotX + 6, y = config.margin + 8, w = config.slotWidth - 12, h = 24 },
            text = "Empty",
            textAlignment = "center",
            textColor = config.colors.textPrimary,
            textSize = 13,
            textFont = ".AppleSystemUIFont",
        })

        dock:appendElements({
            type = "text",
            frame = { x = slotX + 6, y = config.margin + 32, w = config.slotWidth - 12, h = 20 },
            text = "click to open",
            textAlignment = "center",
            textColor = config.colors.textSecondary,
            textSize = 10,
            textFont = ".AppleSystemUIFont",
        })

        -- Notification badge (top-right corner of slot, overlapping edge like app badges)
        local badgeSize = config.notificationBadgeSize
        dock:appendElements({
            type = "circle",
            action = "fill",
            center = { x = slotX + config.slotWidth - badgeSize/3, y = config.margin + badgeSize/3 },
            radius = badgeSize / 2,
            fillColor = { red = 0, green = 0, blue = 0, alpha = 0 },  -- Hidden by default
        })
    end

    -- Add button (right side)
    local addBtnX = slotsStartX + (slotCount * (config.slotWidth + config.gap))
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = addBtnX, y = config.margin, w = config.addButtonWidth, h = config.slotHeight },
        roundedRectRadii = { xRadius = 10, yRadius = 10 },
        fillColor = config.colors.addBtnBg,
        trackMouseUp = true,
        trackMouseEnterExit = true,
        id = "addBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = addBtnX, y = config.margin + 13, w = config.addButtonWidth, h = 30 },
        text = "+",
        textAlignment = "center",
        textColor = config.colors.addBtnText,
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
            end
        elseif event == "mouseExit" and (id == "addBtn" or id == "minBtn" or id == "helpBtn") then
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
    hs.window.filter.windowDestroyed,
    hs.window.filter.windowMinimized,
    hs.window.filter.windowUnminimized,
}, updateAllSlots)

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

-- Hotkeys
hs.hotkey.bind({"cmd", "alt"}, "T", toggleDock)
hs.hotkey.bind({"cmd", "alt"}, "N", addSlot)
hs.hotkey.bind({"cmd", "alt"}, "M", minimizeAllTerminals)
hs.hotkey.bind({"cmd", "alt"}, "R", hs.reload)
hs.hotkey.bind({"cmd", "alt"}, "L", moveMacOSDockLeft)
hs.hotkey.bind({"cmd", "alt"}, "B", moveMacOSDockBottom)

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

    print("\n=== Results: " .. passed .. " passed, " .. failed .. " failed ===\n")
    return failed == 0
end
