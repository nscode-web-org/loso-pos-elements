# Release @nscodecom/loso-pos-elements via CI.
#
# Pushing a v* tag triggers .github/workflows/publish.yml, which builds (tsup) and
# publishes to npm via OIDC trusted publishing.
#
#   make publish              Patch release (x.y.Z+1), then tag + push
#   make publish BUMP=minor   Minor release
#   make publish BUMP=major   Major release
#   make tag-current          Publish the current package.json version as-is

BUMP ?= patch

.PHONY: publish tag-current

publish:
	npm version $(BUMP)
	git push --follow-tags

tag-current:
	git tag v$(shell node -p "require('./package.json').version")
	git push origin v$(shell node -p "require('./package.json').version")
