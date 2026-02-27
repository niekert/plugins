import { describe, expect, it } from "vitest"
import type { Environment } from "./env"
import { parseGithubToSlackMap, resolveMergedBySlackMention } from "./slack"

function createEnvironment(overrides: Partial<Environment> = {}): Environment {
    return {
        PLUGIN_PATH: "/tmp/plugin",
        CHANGELOG: "changelog",
        PR_BODY: undefined,
        SLACK_WEBHOOK_URL: undefined,
        SLACK_ERROR_WEBHOOK_URL: undefined,
        MERGED_BY_GITHUB_HANDLE: undefined,
        GH_TO_SLACK_MAP: undefined,
        SLACK_FALLBACK_MENTION: "@team-plugins",
        RETOOL_URL: undefined,
        GITHUB_RUN_URL: undefined,
        FRAMER_ENV: "production",
        DRY_RUN: false,
        REPO_ROOT: undefined,
        SESSION_TOKEN: "session-token",
        FRAMER_ADMIN_SECRET: "admin-secret",
        ...overrides,
    }
}

describe("parseGithubToSlackMap", () => {
    it("parses and normalizes github and slack handles", () => {
        const mapping = parseGithubToSlackMap("  @Niek : niek ; alice:@alice.dev; bot:bot-helper;")

        expect(mapping).toEqual({
            niek: "@niek",
            alice: "@alice.dev",
            bot: "@bot-helper",
        })
    })

    it("throws for malformed entries", () => {
        expect(() => parseGithubToSlackMap("niek")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("niek:")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap(":@niek")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("a:b:c")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("niek:<@U123456>")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("niek:invalid handle")).toThrow("Invalid GH_TO_SLACK_MAP entry")
    })
})

describe("resolveMergedBySlackMention", () => {
    it("resolves mapped handle with normalization", () => {
        const mention = resolveMergedBySlackMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "@NiEk",
                GH_TO_SLACK_MAP: "niek:marketplace.niek",
            })
        )

        expect(mention).toBe("@marketplace.niek")
    })

    it("accepts GH_TO_SLACK_MAP values with a trailing semicolon", () => {
        const mention = resolveMergedBySlackMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "niek",
                GH_TO_SLACK_MAP: "niek:@marketplace.niek;",
            })
        )

        expect(mention).toBe("@marketplace.niek")
    })

    it("falls back when handle is missing or unmapped", () => {
        const withoutHandle = resolveMergedBySlackMention(createEnvironment())
        const unmappedHandle = resolveMergedBySlackMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "someone-else",
                GH_TO_SLACK_MAP: "niek:@niek",
            })
        )

        expect(withoutHandle).toBe("@team-plugins")
        expect(unmappedHandle).toBe("@team-plugins")
    })

    it("uses custom fallback mention when provided", () => {
        const mention = resolveMergedBySlackMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "missing-user",
                GH_TO_SLACK_MAP: "niek:@niek",
                SLACK_FALLBACK_MENTION: "@marketplace-oncall",
            })
        )

        expect(mention).toBe("@marketplace-oncall")
    })

    it("normalizes custom fallback mention without @", () => {
        const mention = resolveMergedBySlackMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "missing-user",
                GH_TO_SLACK_MAP: "niek:@niek",
                SLACK_FALLBACK_MENTION: "marketplace-oncall",
            })
        )

        expect(mention).toBe("@marketplace-oncall")
    })

    it("falls back when the mapping string is invalid", () => {
        const mention = resolveMergedBySlackMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "niek",
                GH_TO_SLACK_MAP: "broken-entry",
            })
        )

        expect(mention).toBe("@team-plugins")
    })

})
