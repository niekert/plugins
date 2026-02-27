import { describe, expect, it } from "vitest"
import type { Environment } from "./env"
import { parseGithubToSlackMap, resolveSlackUserMention } from "./slack"

function createEnvironment(overrides: Partial<Environment> = {}): Environment {
    return {
        PLUGIN_PATH: "/tmp/plugin",
        CHANGELOG: "changelog",
        PR_BODY: undefined,
        SLACK_WEBHOOK_URL: undefined,
        SLACK_ERROR_WEBHOOK_URL: undefined,
        MERGED_BY_GITHUB_HANDLE: undefined,
        GH_TO_SLACK_MAP: undefined,
        SLACK_FALLBACK_USER_ID: "U999999999",
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
    it("parses and normalizes github handles with slack member IDs", () => {
        const mapping = parseGithubToSlackMap("  @Niek : U0646CHP4UB ; alice:uW1ab23cd ; bot:u03abcde12;")

        expect(mapping).toEqual({
            niek: "U0646CHP4UB",
            alice: "UW1AB23CD",
            bot: "U03ABCDE12",
        })
    })

    it("throws for malformed entries", () => {
        expect(() => parseGithubToSlackMap("niek")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("niek:")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap(":@niek")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("a:b:c")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("niek:<@U0646CHP4UB>")).toThrow("Invalid GH_TO_SLACK_MAP entry")
        expect(() => parseGithubToSlackMap("niek:@niek")).toThrow("Invalid GH_TO_SLACK_MAP entry")
    })

    it("parses a real mapping", () => {
        const mapping = parseGithubToSlackMap(
            "niekert:U0646CHP4UB;triozer:U07TMMYABJL;kaloyanvi:U05PD1NLZEG;madebyisaacr:U08RN09CNQZ;elmarburke:U08QGPJLSV7;tom-james-watson:U05UNC42N74;huntercaron:UM1GY93D2;nick-lucas:U09V83C34HJ;johannes-ger:U08HT3M3NCF"
        )

        expect(mapping).toEqual({
            niekert: "U0646CHP4UB",
            triozer: "U07TMMYABJL",
            kaloyanvi: "U05PD1NLZEG",
            madebyisaacr: "U08RN09CNQZ",
            elmarburke: "U08QGPJLSV7",
            "tom-james-watson": "U05UNC42N74",
            huntercaron: "UM1GY93D2",
            "nick-lucas": "U09V83C34HJ",
            "johannes-ger": "U08HT3M3NCF",
        })
    })
})

describe("resolveSlackUserMention", () => {
    it("resolves mapped member IDs with normalization", () => {
        const mention = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "@NiEk",
                GH_TO_SLACK_MAP: "niek:U0646CHP4UB",
            })
        )

        expect(mention).toBe("U0646CHP4UB")
    })

    it("accepts GH_TO_SLACK_MAP values with a trailing semicolon", () => {
        const mention = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "niek",
                GH_TO_SLACK_MAP: "niek:U0646CHP4UB;",
            })
        )

        expect(mention).toBe("U0646CHP4UB")
    })

    it("resolves mapped member IDs directly", () => {
        const mention = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "niek",
                GH_TO_SLACK_MAP: "niek:UC6B12Z4N",
            })
        )

        expect(mention).toBe("UC6B12Z4N")
    })

    it("falls back when handle is missing or unmapped", () => {
        const withoutHandle = resolveSlackUserMention(createEnvironment())
        const unmappedHandle = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "someone-else",
                GH_TO_SLACK_MAP: "niek:U0646CHP4UB",
            })
        )

        expect(withoutHandle).toBe("U999999999")
        expect(unmappedHandle).toBe("U999999999")
    })

    it("uses custom fallback user ID when provided", () => {
        const mention = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "missing-user",
                GH_TO_SLACK_MAP: "niek:U0646CHP4UB",
                SLACK_FALLBACK_USER_ID: "U123456789",
            })
        )

        expect(mention).toBe("U123456789")
    })

    it("normalizes custom fallback user ID casing", () => {
        const mention = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "missing-user",
                GH_TO_SLACK_MAP: "niek:U0646CHP4UB",
                SLACK_FALLBACK_USER_ID: "u123abc456",
            })
        )

        expect(mention).toBe("U123ABC456")
    })

    it("supports fallback member IDs", () => {
        const mention = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "missing-user",
                GH_TO_SLACK_MAP: "niek:U0646CHP4UB",
                SLACK_FALLBACK_USER_ID: "UC6B12Z4N",
            })
        )

        expect(mention).toBe("UC6B12Z4N")
    })

    it("falls back when the mapping string is invalid", () => {
        const mention = resolveSlackUserMention(
            createEnvironment({
                MERGED_BY_GITHUB_HANDLE: "niek",
                GH_TO_SLACK_MAP: "broken-entry",
            })
        )

        expect(mention).toBe("U999999999")
    })
})
