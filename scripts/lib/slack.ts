import type { Environment } from "./env"
import { getURL } from "./env"
import type { FramerJson, SubmissionResponse } from "./framer-api"
import { log } from "./logging"

interface SlackWorkflowPayload {
    pluginName: string
    retoolUrl?: string
    marketplacePreviewUrl: string
    pluginVersion: string
    pluginReviewUrl: string
    changelog: string
    mergedBySlackMention: string
}

const DEFAULT_SLACK_FALLBACK_MENTION = "@team-plugins"
const SLACK_HANDLE_PATTERN = /^@?[A-Za-z0-9._-]+$/

function normalizeGithubHandle(handle: string): string {
    return handle.trim().replace(/^@+/, "").toLowerCase()
}

function normalizeSlackMention(mention: string): string {
    const trimmed = mention.trim()
    return trimmed.startsWith("@") ? trimmed : `@${trimmed}`
}

function isValidSlackHandle(mention: string): boolean {
    return SLACK_HANDLE_PATTERN.test(mention.trim())
}

export function parseGithubToSlackMap(mapString: string): Record<string, string> {
    const parsedMap: Record<string, string> = {}
    const pairs = mapString
        .split(";")
        .map(pair => pair.trim())
        .filter(Boolean)

    for (const pair of pairs) {
        const separatorIndex = pair.indexOf(":")
        if (separatorIndex === -1 || separatorIndex !== pair.lastIndexOf(":")) {
            throw new Error(
                `Invalid GH_TO_SLACK_MAP entry "${pair}". Expected "github:slack" pairs separated by semicolons.`
            )
        }

        const github = normalizeGithubHandle(pair.slice(0, separatorIndex))
        const slackRaw = pair.slice(separatorIndex + 1).trim()

        if (!github || !slackRaw) {
            throw new Error(`Invalid GH_TO_SLACK_MAP entry "${pair}". Expected non-empty GitHub and Slack handles.`)
        }
        if (!isValidSlackHandle(slackRaw)) {
            throw new Error(
                `Invalid GH_TO_SLACK_MAP entry "${pair}". Slack handle must optionally start with "@" and contain only letters, numbers, ".", "_" or "-".`
            )
        }

        parsedMap[github] = normalizeSlackMention(slackRaw)
    }

    return parsedMap
}

export function resolveMergedBySlackMention(env: Environment): string {
    const fallbackMentionInput = env.SLACK_FALLBACK_MENTION.trim()
    const fallbackMention = fallbackMentionInput
        ? normalizeSlackMention(fallbackMentionInput)
        : DEFAULT_SLACK_FALLBACK_MENTION
    const mergedByGithubHandle = env.MERGED_BY_GITHUB_HANDLE
    if (!mergedByGithubHandle) {
        return fallbackMention
    }

    const normalizedHandle = normalizeGithubHandle(mergedByGithubHandle)
    if (!normalizedHandle) {
        return fallbackMention
    }

    const mapString = env.GH_TO_SLACK_MAP?.trim()
    if (!mapString) {
        return fallbackMention
    }

    try {
        const mapping = parseGithubToSlackMap(mapString)
        return mapping[normalizedHandle] ?? fallbackMention
    } catch (err) {
        log.error(`Invalid GH_TO_SLACK_MAP: ${err instanceof Error ? err.message : String(err)}`)
        return fallbackMention
    }
}

export async function sendSlackNotification(
    framerJson: FramerJson,
    submissionResult: SubmissionResponse,
    env: Environment,
    changelog: string
): Promise<void> {
    const payload: SlackWorkflowPayload = {
        pluginName: framerJson.name,
        pluginVersion: submissionResult.version.toString(),
        marketplacePreviewUrl: `${getURL(env, "marketplaceBaseUrl")}/plugins/${submissionResult.slug}/preview`,
        pluginReviewUrl: `${getURL(env, "framerAppUrl")}/projects/new?plugin=${submissionResult.internalPluginId}&pluginVersion=${submissionResult.versionId}`,
        changelog: changelog,
        mergedBySlackMention: resolveMergedBySlackMention(env),
        retoolUrl: env.RETOOL_URL,
    }

    if (!env.SLACK_WEBHOOK_URL) return

    try {
        const response = await fetch(env.SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })

        if (!response.ok) {
            log.error(`Slack notification failed: ${response.status}`)
        } else {
            log.success("Slack notification sent")
        }
    } catch (err) {
        log.error(`Slack notification error: ${err instanceof Error ? err.message : String(err)}`)
    }
}

export async function sendErrorNotification(
    errorMessage: string,
    pluginName: string | undefined,
    env: Environment
): Promise<void> {
    if (!env.SLACK_ERROR_WEBHOOK_URL) return

    const payload = {
        githubActionRunUrl: env.GITHUB_RUN_URL ?? "N/A (not running in GitHub Actions)",
        errorMessage,
        pluginName: pluginName ?? "Unknown",
    }

    try {
        const response = await fetch(env.SLACK_ERROR_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })

        if (!response.ok) {
            log.error(`Error notification failed: ${response.status}`)
        } else {
            log.success("Error notification sent")
        }
    } catch (err) {
        log.error(`Error notification error: ${err instanceof Error ? err.message : String(err)}`)
    }
}
