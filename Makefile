# Workspace P2P Spike — convenience targets for containerised testing.
#
# Run `make` with no arguments to see available targets.
#
# The `demo` target is the one-command quick start: it checks for a
# container runtime, starts Colima if installed but not running, builds
# the image (if needed), runs the Acme small-org demo end-to-end, then
# exits. The bootstrap container stops with it.
#
# Compatible with any Docker-CLI-providing runtime: Colima (recommended,
# fully FOSS), OrbStack (source-available), Docker Desktop (commercial
# for orgs over the size threshold), or native Docker Engine on Linux.

.DEFAULT_GOAL := help

.PHONY: help check demo stop clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} \
	     /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' \
	     $(MAKEFILE_LIST)
	@echo ""
	@echo "Container-runtime install (macOS, pick one):"
	@echo "  Colima        brew install colima docker         (fully FOSS, recommended)"
	@echo "  OrbStack      brew install --cask orbstack       (source-available)"
	@echo "  Docker Desktop https://docs.docker.com/desktop/install/mac-install/"

check: ## Verify a container runtime is installed + reachable
	@command -v docker >/dev/null 2>&1 || { \
		echo "Docker CLI not found. See 'make help' for install options."; \
		exit 1; \
	}
	@docker info >/dev/null 2>&1 || { \
		if command -v colima >/dev/null 2>&1; then \
			echo "Container daemon not running — starting Colima..."; \
			colima start; \
		else \
			echo "Container daemon not running. Start your runtime first."; \
			echo "(e.g. open Docker Desktop / OrbStack, or run 'colima start')"; \
			exit 1; \
		fi; \
	}

demo: check ## Build + run the Acme demo end-to-end (auto-starts Colima if needed)
	docker compose up --build --abort-on-container-exit acme

stop: ## Stop the Colima VM (if installed and running)
	@if command -v colima >/dev/null 2>&1; then \
		colima stop 2>/dev/null || true; \
	fi

clean: ## Tear down containers + volumes; stop Colima
	docker compose down -v 2>/dev/null || true
	@if command -v colima >/dev/null 2>&1; then \
		colima stop 2>/dev/null || true; \
	fi
