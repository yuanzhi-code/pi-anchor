#!/bin/bash

# Release script for pi-anchor
# Usage: ./scripts/release.sh [patch|minor|major|prepatch|preminor|premajor|prerelease]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${RED}Error: Must be on main branch to release${NC}"
    echo "Current branch: $CURRENT_BRANCH"
    exit 1
fi

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${RED}Error: There are uncommitted changes${NC}"
    git status --short
    exit 1
fi

# Get version bump type (default to patch)
BUMP_TYPE=${1:-patch}

# Validate bump type
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major|prepatch|preminor|premajor|prerelease)$ ]]; then
    echo -e "${RED}Error: Invalid bump type '$BUMP_TYPE'${NC}"
    echo "Valid types: patch, minor, major, prepatch, preminor, premajor, prerelease"
    exit 1
fi

echo -e "${YELLOW}Preparing release with version bump: $BUMP_TYPE${NC}"

# Pull latest changes
echo -e "${GREEN}Pulling latest changes...${NC}"
git pull origin main

# Run tests
echo -e "${GREEN}Running tests...${NC}"
npm test

# Bump version
echo -e "${GREEN}Bumping version...${NC}"
NEW_VERSION=$(npm version $BUMP_TYPE --no-git-tag-version)
echo -e "${GREEN}New version: $NEW_VERSION${NC}"

# Commit version bump
echo -e "${GREEN}Committing version bump...${NC}"
git add package.json package-lock.json 2>/dev/null || true
git commit -m "chore: bump version to $NEW_VERSION"

# Create git tag
echo -e "${GREEN}Creating git tag...${NC}"
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

# Push changes and tag
echo -e "${GREEN}Pushing changes and tag...${NC}"
git push origin main
git push origin "$NEW_VERSION"

echo -e "${GREEN}✓ Release $NEW_VERSION created successfully!${NC}"
echo ""
echo "The CI/CD pipeline will now:"
echo "  1. Run tests"
echo "  2. Build the package"
echo "  3. Publish to npm"
echo "  4. Create a GitHub release"
echo ""
echo "Monitor the progress at: https://github.com/yuanzhi-code/pi-anchor/actions"
