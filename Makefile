# Short commands for webclone. Run `make` to see them all.
#
#   make clone URL=devark.studio            clone a page
#   make static URL=devark.studio           clone as a static snapshot (no JS)
#   make preview URL=devark.studio          clone, then open the preview server
#   make serve                              preview the most recent clone
#   make serve DIR=cloned_sites/example.com preview a specific clone

URL  ?=
OUT  ?=
PORT ?= 8000
# Default folder for `make serve`: the most recently cloned site.
DIR  ?= $(shell ls -td cloned_sites/*/ 2>/dev/null | head -1)

CLI      := WEBCLONE_VIA_MAKE=1 node bin/webclone.js
OUT_FLAG := $(if $(OUT),-o "$(OUT)",)

.DEFAULT_GOAL := help
.PHONY: help install clone static preview serve list clean link unlink

help: ## Show this list of commands
	@echo ""
	@echo "webclone - clone a web page into HTML / CSS / JS"
	@echo ""
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-10s %s\n", $$1, $$2}'
	@echo ""
	@echo "Options:  URL=<site>  OUT=<folder>  DIR=<folder>  PORT=<port>"
	@echo "Example:  make preview URL=devark.studio"
	@echo ""

install: node_modules ## Install dependencies (other commands do this automatically)

# Re-runs npm install only when package.json changes.
node_modules: package.json
	npm install
	@touch node_modules

clone: node_modules ## Clone a page (HTML + CSS + JS)       URL=example.com
	@test -n "$(URL)" || (echo "Usage: make clone URL=example.com" && exit 1)
	@$(CLI) "$(URL)" $(OUT_FLAG)

static: node_modules ## Clone a static snapshot, no JS       URL=example.com
	@test -n "$(URL)" || (echo "Usage: make static URL=example.com" && exit 1)
	@$(CLI) "$(URL)" --static $(OUT_FLAG)

preview: node_modules ## Clone, then open the preview server  URL=example.com
	@test -n "$(URL)" || (echo "Usage: make preview URL=example.com" && exit 1)
	@$(CLI) "$(URL)" --serve --port $(PORT) $(OUT_FLAG)

serve: node_modules ## Preview the latest clone             [DIR=cloned_sites/x]
	@test -n "$(DIR)" || (echo "Nothing cloned yet. Run: make clone URL=example.com" && exit 1)
	@$(CLI) serve "$(DIR)" --port $(PORT)

list: ## List cloned sites, newest first
	@ls -td cloned_sites/*/ 2>/dev/null | while read d; do echo "  $$(du -sh "$$d" | cut -f1)	$$d"; done || true
	@ls cloned_sites 2>/dev/null | grep -q . || echo "  No cloned sites yet."

clean: ## Delete all cloned sites (asks first)
	@if ! ls cloned_sites 2>/dev/null | grep -q .; then \
		echo "Nothing to delete."; \
	else \
		printf "Delete everything in cloned_sites/? [y/N] "; read answer; \
		if [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then rm -rf cloned_sites && echo "Deleted."; else echo "Cancelled."; fi; \
	fi

link: node_modules ## Install `webclone` as a global command
	npm link
	@echo "Done. You can now run: webclone <url>"

unlink: ## Remove the global `webclone` command
	npm unlink -g webclone
