VERSION := $(shell node -p "require('./package.json').version")

.PHONY: release
release:
	@echo "Releasing version $(VERSION)"
	git tag -a "v$(VERSION)" -m "Release v$(VERSION)"
	git push origin "v$(VERSION)"
