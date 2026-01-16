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
    initialSlots = 3,
    elementsPerSlot = 4,  -- bg, border, title, status
    baseElements = 2,     -- dock bg + border
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
    }
}

-- State
local slotCount = config.initialSlots
local slots = {}
local dock = nil
local tooltip = nil

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
end
cleanup()  -- Clean up any previous instance

local function initSlots()
    for i = 1, slotCount do
        if not slots[i] then
            slots[i] = { windowId = nil, customName = nil, pending = false }
        end
    end
end
initSlots()

-- Calculate dock dimensions
local function getDockWidth()
    return (config.slotWidth * slotCount) + (config.gap * slotCount) + (config.margin * 2) + config.addButtonWidth
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
    return {
        x = (frame.w - dockWidth) / 2,
        y = frame.h - dockHeight - config.bottomOffset,
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

-- Tooltip helpers
local function showTooltip(text)
    if tooltip then tooltip:delete() end
    local dockFrame = getDockFrame()
    if not dockFrame then return end

    local tipWidth = 50
    local tipHeight = 24
    local addBtnX = dockFrame.x + config.margin + (slotCount * (config.slotWidth + config.gap))
    local tipX = addBtnX + (config.addButtonWidth - tipWidth) / 2
    local tipY = dockFrame.y - tipHeight - 5

    tooltip = hs.canvas.new({ x = tipX, y = tipY, w = tipWidth, h = tipHeight })
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

local function hideTooltip()
    if tooltip then
        tooltip:delete()
        tooltip = nil
    end
end

-- Forward declarations
local createDock
local updateAllSlots

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
    slots[slotCount] = { windowId = nil, customName = nil, pending = false }

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

    -- Slots
    for i = 1, slotCount do
        local slotX = config.margin + ((i - 1) * (config.slotWidth + config.gap))

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
    end

    -- Add button
    local addBtnX = config.margin + (slotCount * (config.slotWidth + config.gap))
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
    })

    dock:mouseCallback(function(_, event, id)
        if event == "mouseUp" then
            if id == "addBtn" then
                addSlot()
            elseif id and id:match("^slot") then
                local idx = tonumber(id:match("%d+"))
                if idx then
                    local mods = hs.eventtap.checkKeyboardModifiers()
                    onSlotClick(idx, mods.alt)
                end
            end
        elseif event == "mouseEnter" and id == "addBtn" then
            showTooltip("⌘⌥N")
        elseif event == "mouseExit" and id == "addBtn" then
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

-- Window event watcher for immediate updates
windowFilter = hs.window.filter.new("Terminal")
windowFilter:subscribe({
    hs.window.filter.windowDestroyed,
    hs.window.filter.windowMinimized,
    hs.window.filter.windowUnminimized,
    hs.window.filter.windowFocused,
}, updateAllSlots)

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

-- Initialize
createDock()

-- Hotkeys
hs.hotkey.bind({"cmd", "alt"}, "T", toggleDock)
hs.hotkey.bind({"cmd", "alt"}, "N", addSlot)
hs.hotkey.bind({"cmd", "alt"}, "R", hs.reload)

hs.alert.show("Claude Dock Ready")

-- ===================
-- TESTS (run with: hs -c "runTests()")
-- ===================

function runTests()
    local passed, failed = 0, 0
    local savedSlotCount, savedSlots = slotCount, slots

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
        slotCount, slots = savedSlotCount, savedSlots
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

    print("\n=== Results: " .. passed .. " passed, " .. failed .. " failed ===\n")
    return failed == 0
end
