.PHONY: help dev build build-macos-arm64 build-macos-x64 build-windows-x64 build-universal clean

help: ## Show this help message
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

dev: ## Start the Tauri dev server
	pnpm tauri dev

build: ## Build for the current platform
	pnpm tauri build

build-macos-arm64: ## Build for macOS Apple Silicon (arm64)
	pnpm tauri build --target aarch64-apple-darwin

build-macos-x64: ## Build for macOS Intel (x64)
	pnpm tauri build --target x86_64-apple-darwin

build-universal: ## Build universal macOS binary (arm64 + x64)
	pnpm tauri build --target universal-apple-darwin

build-windows-x64: ## Build for Windows x64 (requires cross-compilation setup)
	@echo "Windows builds should be run on a Windows machine or via GitHub Actions."
	@echo "See .github/workflows/build.yml for automated Windows builds."
	@exit 1

clean: ## Clean build artifacts
	cd src-tauri && cargo clean
	rm -rf dist
