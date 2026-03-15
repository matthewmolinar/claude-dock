APP_NAME = ClaudeDock
BUILD_DIR = .build
APP_BUNDLE = $(BUILD_DIR)/$(APP_NAME).app

.PHONY: build run clean install

build:
	swift build -c release
	@echo "Creating app bundle..."
	@mkdir -p "$(APP_BUNDLE)/Contents/MacOS"
	@mkdir -p "$(APP_BUNDLE)/Contents/Resources"
	@cp $(BUILD_DIR)/release/$(APP_NAME) "$(APP_BUNDLE)/Contents/MacOS/$(APP_NAME)"
	@cp Resources/Info.plist "$(APP_BUNDLE)/Contents/"
	@echo "Built $(APP_BUNDLE)"

run: build
	@open "$(APP_BUNDLE)"

clean:
	swift package clean
	@rm -rf "$(APP_BUNDLE)"

install: build
	@echo "Installing to /Applications..."
	@cp -R "$(APP_BUNDLE)" /Applications/
	@echo "Installed $(APP_NAME).app to /Applications"
