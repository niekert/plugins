import { describe, expect, it } from "vitest"
import { extractChangelog, parseChangedPlugins } from "./parse-pr"

describe("extractChangelog", () => {
    it("extracts changelog content from PR body", () => {
        const prBody = `### Description

This PR adds a new feature.

### Changelog

- Added support for multiple locations
- Fixed bug with slug generation

### Testing

- Test case 1`

        expect(extractChangelog(prBody)).toBe(
            "- Added support for multiple locations\n- Fixed bug with slug generation"
        )
    })

    it("returns null for empty PR body", () => {
        expect(extractChangelog("")).toBeNull()
        expect(extractChangelog(null as unknown as string)).toBeNull()
    })

    it("returns null when changelog section is missing", () => {
        const prBody = `### Description

This PR adds a new feature.

### Testing

- Test case 1`

        expect(extractChangelog(prBody)).toBeNull()
    })

    it("returns null when changelog is just a placeholder dash", () => {
        const prBody = `### Description

This PR adds a new feature.

### Changelog

-

### Testing

- Test case 1`

        expect(extractChangelog(prBody)).toBeNull()
    })

    it("returns null when changelog section is empty", () => {
        const prBody = `### Description

This PR adds a new feature.

### Changelog

### Testing

- Test case 1`

        expect(extractChangelog(prBody)).toBeNull()
    })

    it("handles changelog at end of PR body (no following section)", () => {
        const prBody = `### Description

This PR adds a new feature.

### Changelog

- Fixed a critical bug
- Improved performance`

        expect(extractChangelog(prBody)).toBe("- Fixed a critical bug\n- Improved performance")
    })

    it("handles ## headings after changelog", () => {
        const prBody = `### Description

This PR adds a new feature.

### Changelog

- Added new feature

## Additional Notes

Some notes here.`

        expect(extractChangelog(prBody)).toBe("- Added new feature")
    })

    it("is case insensitive for heading", () => {
        const prBody = `### CHANGELOG

- Fixed bug`

        expect(extractChangelog(prBody)).toBe("- Fixed bug")
    })

    it("trims whitespace from changelog content", () => {
        const prBody = `### Changelog

   - Added feature with extra whitespace

### Testing`

        expect(extractChangelog(prBody)).toBe("- Added feature with extra whitespace")
    })
})

describe("parseChangedPlugins", () => {
    it("extracts plugin names from changed files", () => {
        const changedFiles = "plugins/csv-import/src/index.ts plugins/csv-import/package.json"
        expect(parseChangedPlugins(changedFiles)).toEqual(["csv-import"])
    })

    it("returns unique plugin names when multiple files changed in same plugin", () => {
        const changedFiles =
            "plugins/airtable/src/App.tsx plugins/airtable/src/utils.ts plugins/airtable/package.json"
        expect(parseChangedPlugins(changedFiles)).toEqual(["airtable"])
    })

    it("returns multiple plugins sorted alphabetically", () => {
        const changedFiles =
            "plugins/csv-import/src/index.ts plugins/airtable/src/App.tsx plugins/ashby/framer.json"
        expect(parseChangedPlugins(changedFiles)).toEqual(["airtable", "ashby", "csv-import"])
    })

    it("ignores files outside plugins directory", () => {
        const changedFiles =
            "scripts/submit-plugin.ts packages/plugin-tools/src/index.ts plugins/csv-import/src/index.ts README.md"
        expect(parseChangedPlugins(changedFiles)).toEqual(["csv-import"])
    })

    it("returns empty array when no plugin files changed", () => {
        const changedFiles = "scripts/submit-plugin.ts README.md .github/workflows/ci.yml"
        expect(parseChangedPlugins(changedFiles)).toEqual([])
    })

    it("returns empty array for empty input", () => {
        expect(parseChangedPlugins("")).toEqual([])
        expect(parseChangedPlugins("   ")).toEqual([])
    })

    it("handles files at root of plugins directory (should not match)", () => {
        // Files directly in plugins/ without a subdirectory should not match
        const changedFiles = "plugins/.DS_Store plugins/README.md"
        expect(parseChangedPlugins(changedFiles)).toEqual([])
    })

    it("handles deeply nested files", () => {
        const changedFiles = "plugins/airtable/src/components/Button/index.tsx"
        expect(parseChangedPlugins(changedFiles)).toEqual(["airtable"])
    })

    it("handles newline-separated files", () => {
        const changedFiles = "plugins/csv-import/src/index.ts\nplugins/airtable/src/App.tsx"
        expect(parseChangedPlugins(changedFiles)).toEqual(["airtable", "csv-import"])
    })

    it("handles tab-separated files", () => {
        const changedFiles = "plugins/csv-import/src/index.ts\tplugins/airtable/src/App.tsx"
        expect(parseChangedPlugins(changedFiles)).toEqual(["airtable", "csv-import"])
    })
})
