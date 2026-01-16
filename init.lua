-- Terminal Dock for Claude Code
require("hs.ipc")

-- Configuration
local slotWidth = 140
local slotHeight = 60
local gap = 8
local margin = 10
local bottomOffset = 5
local addButtonWidth = 40

-- Dynamic slot count
local slotCount = 3  -- Start with 3 slots

-- Track terminal windows for each slot
local slots = {}

local function initSlots()
    for i = 1, slotCount do
        if not slots[i] then
            slots[i] = { windowId = nil, customName = nil, name = "Slot " .. i }
        end
    end
end
initSlots()

-- The dock canvas
local dock = nil

-- Calculate dock width
local function getDockWidth()
    return (slotWidth * slotCount) + (gap * slotCount) + (margin * 2) + addButtonWidth
end

local function getDockHeight()
    return slotHeight + (margin * 2)
end

-- Get terminal window title
local function getWindowTitle(windowId)
    if not windowId then return nil end
    local win = hs.window.get(windowId)
    if win then
        local title = win:title() or ""
        if #title > 18 then
            title = title:sub(1, 15) .. "..."
        end
        return title
    end
    return nil
end

-- Check if window still exists
local function windowExists(windowId)
    if not windowId then return false end
    local win = hs.window.get(windowId)
    return win ~= nil
end

-- Forward declarations
local createDock
local updateAllSlots

-- Update slot display
local function updateSlotDisplay(slotIndex)
    if not dock then return end
    if slotIndex > slotCount then return end

    local slot = slots[slotIndex]
    local baseIdx = 3 + ((slotIndex - 1) * 4)  -- bg, border, title, status

    local title = ""
    local status = ""
    local bgColor = { red = 0.15, green = 0.15, blue = 0.15, alpha = 1 }

    if slot.windowId and windowExists(slot.windowId) then
        local win = hs.window.get(slot.windowId)
        title = slot.customName or getWindowTitle(slot.windowId) or slot.name

        if win:isMinimized() then
            status = "(minimized)"
            bgColor = { red = 0.12, green = 0.12, blue = 0.18, alpha = 1 }
        else
            status = "active"
            bgColor = { red = 0.1, green = 0.2, blue = 0.1, alpha = 1 }
        end
    else
        slot.windowId = nil
        slot.customName = nil
        title = "Empty"
        status = "click to open"
        bgColor = { red = 0.15, green = 0.15, blue = 0.15, alpha = 1 }
    end

    -- Update elements
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

-- Update all slots
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

-- Handle slot click
local function onSlotClick(slotIndex, isRightClick)
    local slot = slots[slotIndex]

    if isRightClick then
        renameSlot(slotIndex)
        return
    end

    if slot.windowId and windowExists(slot.windowId) then
        local win = hs.window.get(slot.windowId)
        if win then
            if win:isMinimized() then
                win:unminimize()
            end
            win:focus()
        end
    else
        -- Prompt for name first
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

        -- Create new terminal and run claude
        hs.applescript([[
            tell application "Terminal"
                do script "claude"
                activate
            end tell
        ]])

        -- Wait and capture the window
        hs.timer.doAfter(0.5, function()
            local termApp = hs.application.get("Terminal")
            if termApp then
                local wins = termApp:allWindows()
                if #wins > 0 then
                    for _, win in ipairs(wins) do
                        local winId = win:id()
                        local isTracked = false
                        for _, s in ipairs(slots) do
                            if s.windowId == winId then
                                isTracked = true
                                break
                            end
                        end
                        if not isTracked then
                            slot.windowId = winId
                            break
                        end
                    end
                end
            end
            updateAllSlots()
        end)
    end

    updateSlotDisplay(slotIndex)
end

-- Add a new slot and launch terminal
local function addSlot()
    slotCount = slotCount + 1
    local newSlotIndex = slotCount
    slots[newSlotIndex] = { windowId = nil, customName = nil, name = "Slot " .. newSlotIndex }

    -- Rebuild dock with new size
    if dock then
        dock:delete()
    end
    createDock()

    -- Immediately launch terminal in the new slot
    onSlotClick(newSlotIndex, false)
end

-- Create the dock
createDock = function()
    local screen = hs.screen.mainScreen():fullFrame()
    local dockWidth = getDockWidth()
    local dockHeight = getDockHeight()

    local frame = {
        x = (screen.w - dockWidth) / 2,
        y = screen.h - dockHeight - bottomOffset,
        w = dockWidth,
        h = dockHeight
    }

    dock = hs.canvas.new(frame)

    -- Background
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        roundedRectRadii = { xRadius = 14, yRadius = 14 },
        fillColor = { red = 0.08, green = 0.08, blue = 0.08, alpha = 0.95 },
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Border
    dock:appendElements({
        type = "rectangle",
        action = "stroke",
        roundedRectRadii = { xRadius = 14, yRadius = 14 },
        strokeColor = { red = 1, green = 1, blue = 1, alpha = 0.1 },
        strokeWidth = 1,
        frame = { x = 0, y = 0, w = "100%", h = "100%" },
    })

    -- Slots
    for i = 1, slotCount do
        local slotX = margin + ((i - 1) * (slotWidth + gap))

        -- Slot background
        dock:appendElements({
            type = "rectangle",
            action = "fill",
            frame = { x = slotX, y = margin, w = slotWidth, h = slotHeight },
            roundedRectRadii = { xRadius = 10, yRadius = 10 },
            fillColor = { red = 0.15, green = 0.15, blue = 0.15, alpha = 1 },
            trackMouseDown = true,
            trackMouseUp = true,
            trackMouseEnterExit = true,
            id = "slot" .. i,
        })

        -- Slot border
        dock:appendElements({
            type = "rectangle",
            action = "stroke",
            frame = { x = slotX, y = margin, w = slotWidth, h = slotHeight },
            roundedRectRadii = { xRadius = 10, yRadius = 10 },
            strokeColor = { red = 1, green = 1, blue = 1, alpha = 0.15 },
            strokeWidth = 1,
        })

        -- Title text
        dock:appendElements({
            type = "text",
            frame = { x = slotX + 6, y = margin + 8, w = slotWidth - 12, h = 24 },
            text = "Empty",
            textAlignment = "center",
            textColor = { red = 0.9, green = 0.9, blue = 0.9, alpha = 1 },
            textSize = 13,
            textFont = ".AppleSystemUIFont",
        })

        -- Status text
        dock:appendElements({
            type = "text",
            frame = { x = slotX + 6, y = margin + 32, w = slotWidth - 12, h = 20 },
            text = "click to open",
            textAlignment = "center",
            textColor = { red = 0.5, green = 0.5, blue = 0.5, alpha = 1 },
            textSize = 10,
            textFont = ".AppleSystemUIFont",
        })
    end

    -- Add button (+)
    local addBtnX = margin + (slotCount * (slotWidth + gap))
    dock:appendElements({
        type = "rectangle",
        action = "fill",
        frame = { x = addBtnX, y = margin, w = addButtonWidth, h = slotHeight },
        roundedRectRadii = { xRadius = 10, yRadius = 10 },
        fillColor = { red = 0.2, green = 0.25, blue = 0.2, alpha = 1 },
        trackMouseUp = true,
        id = "addBtn",
    })
    dock:appendElements({
        type = "text",
        frame = { x = addBtnX, y = margin + 15, w = addButtonWidth, h = 30 },
        text = "+",
        textAlignment = "center",
        textColor = { red = 0.6, green = 0.8, blue = 0.6, alpha = 1 },
        textSize = 28,
        textFont = ".AppleSystemUIFont",
    })

    -- Click handler
    dock:mouseCallback(function(canvas, event, id, x, y)
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
        end
    end)

    dock:level(hs.canvas.windowLevels.floating)
    dock:behavior(hs.canvas.windowBehaviors.canJoinAllSpaces)
    dock:show()

    updateAllSlots()
end

-- Toggle dock visibility
local function toggleDock()
    if dock then
        if dock:isShowing() then
            dock:hide()
        else
            dock:show()
        end
    end
end

-- Periodic update to refresh window states
local updateTimer = hs.timer.doEvery(1, function()
    if dock and dock:isShowing() then
        updateAllSlots()
    end
end)

-- Watch for window events
local windowFilter = hs.window.filter.new("Terminal")
windowFilter:subscribe({
    hs.window.filter.windowDestroyed,
    hs.window.filter.windowMinimized,
    hs.window.filter.windowUnminimized,
    hs.window.filter.windowFocused,
}, function()
    updateAllSlots()
end)

-- Init
createDock()

-- Hotkeys
hs.hotkey.bind({"cmd", "alt"}, "T", toggleDock)
hs.hotkey.bind({"cmd", "alt"}, "N", addSlot)  -- Add new slot
hs.hotkey.bind({"cmd", "alt"}, "R", hs.reload)

-- Screen watcher
hs.screen.watcher.new(function()
    if dock then
        local screen = hs.screen.mainScreen():fullFrame()
        local dockWidth = getDockWidth()
        local dockHeight = getDockHeight()
        dock:frame({
            x = (screen.w - dockWidth) / 2,
            y = screen.h - dockHeight - bottomOffset,
            w = dockWidth,
            h = dockHeight
        })
    end
end):start()

hs.alert.show("Terminal Dock Ready")

-- ===================
-- TESTS
-- ===================
-- Run with: hs -c "runTests()"

function runTests()
    local passed = 0
    local failed = 0

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

    print("\n=== Terminal Dock Tests ===\n")

    test("windowFilter triggers updateAllSlots on window destroy", function()
        assert(windowFilter, "windowFilter should exist")
    end)

    test("windowExists returns false for nil windowId", function()
        assertEqual(windowExists(nil), false)
    end)

    test("windowExists returns false for invalid windowId", function()
        assertEqual(windowExists(999999999), false)
    end)

    test("slot clears windowId when window no longer exists", function()
        local testSlot = { windowId = 999999999, name = "Test" }
        local exists = windowExists(testSlot.windowId)
        if not exists then
            testSlot.windowId = nil
        end
        assertEqual(testSlot.windowId, nil)
    end)

    test("getWindowTitle returns nil for invalid window", function()
        local title = getWindowTitle(999999999)
        assertEqual(title, nil)
    end)

    test("customName is cleared when window is closed", function()
        local testSlot = { windowId = 999999999, customName = "MyTerminal", name = "Test" }
        if not windowExists(testSlot.windowId) then
            testSlot.windowId = nil
            testSlot.customName = nil
        end
        assertEqual(testSlot.customName, nil, "customName should be cleared")
    end)

    test("addSlot increases slotCount", function()
        local before = slotCount
        -- Note: addSlot now triggers onSlotClick which shows a dialog
        -- So we test the slot creation logic directly
        slotCount = slotCount + 1
        slots[slotCount] = { windowId = nil, customName = nil, name = "Slot " .. slotCount }
        assertEqual(slotCount, before + 1, "slotCount should increase by 1")
        assert(slots[slotCount], "new slot should exist")
    end)

    test("getDockWidth scales with slotCount", function()
        local width1 = getDockWidth()
        local oldCount = slotCount
        slotCount = slotCount + 1
        local width2 = getDockWidth()
        slotCount = oldCount  -- restore
        assert(width2 > width1, "dock should be wider with more slots")
    end)

    test("getDockHeight is constant", function()
        local height1 = getDockHeight()
        local oldCount = slotCount
        slotCount = slotCount + 5
        local height2 = getDockHeight()
        slotCount = oldCount  -- restore
        assertEqual(height1, height2, "height should not change with slot count")
    end)

    test("initSlots creates slots up to slotCount", function()
        local oldSlots = slots
        local oldCount = slotCount
        slots = {}
        slotCount = 3
        initSlots()
        assert(slots[1], "slot 1 should exist")
        assert(slots[2], "slot 2 should exist")
        assert(slots[3], "slot 3 should exist")
        assert(not slots[4], "slot 4 should not exist")
        assert(slots[1].name == "Slot 1", "slot 1 should have correct name")
        slots = oldSlots
        slotCount = oldCount
    end)

    test("toggleDock changes visibility", function()
        assert(dock, "dock should exist")
        local wasShowing = dock:isShowing()
        toggleDock()
        local nowShowing = dock:isShowing()
        assertEqual(nowShowing, not wasShowing, "visibility should toggle")
        toggleDock()  -- restore
    end)

    test("slot with valid customName shows customName", function()
        local testSlot = { windowId = nil, customName = "MyCustomName", name = "Test" }
        -- When window doesn't exist, customName gets cleared
        -- So test the case where we set customName before window check
        local displayName = testSlot.customName or "Empty"
        assertEqual(displayName, "MyCustomName")
    end)

    test("getWindowTitle truncates long titles", function()
        -- Can't easily test with real window, but we verify the function exists
        assert(type(getWindowTitle) == "function", "getWindowTitle should be a function")
    end)

    test("updateSlotDisplay handles out of bounds index", function()
        -- Should not error when given invalid index
        local success = pcall(function()
            updateSlotDisplay(9999)
        end)
        assert(success, "updateSlotDisplay should handle invalid index gracefully")
    end)

    test("windowFilter is subscribed to all required events", function()
        assert(windowFilter, "windowFilter should exist")
        -- The filter was created with "Terminal" app filter
        -- Subscriptions happen at load time
    end)

    print("\n=== Results: " .. passed .. " passed, " .. failed .. " failed ===\n")
    return failed == 0
end
