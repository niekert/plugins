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
    slackUserMention: string
}

const SLACK_USER_ID_PATTERN = /^U[A-Z0-9]{8,}$/i

function normalizeGithubHandle(handle: string): string {
    return handle.trim().replace(/^@+/, "").toLowerCase()
}

function normalizeSlackUserId(userId: string): string {
    return userId.trim().toUpperCase()
}

function isValidSlackUserId(userId: string): boolean {
    return SLACK_USER_ID_PATTERN.test(userId.trim())
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
                `Invalid GH_TO_SLACK_MAP entry "${pair}". Expected "github:slack_user_id" pairs separated by semicolons.`
            )
        }

        const github = normalizeGithubHandle(pair.slice(0, separatorIndex))
        const slackRaw = pair.slice(separatorIndex + 1).trim()

        if (!github || !slackRaw) {
            throw new Error(`Invalid GH_TO_SLACK_MAP entry "${pair}". Expected non-empty GitHub and Slack user ID.`)
        }
        if (!isValidSlackUserId(slackRaw)) {
            throw new Error(
                `Invalid GH_TO_SLACK_MAP entry "${pair}". Slack value must be a Slack user ID starting with "U" (for example "U0646CHP4UB").`
            )
        }

        parsedMap[github] = normalizeSlackUserId(slackRaw)
    }

    return parsedMap
}

export function resolveSlackUserMention(env: Environment): string {
    const fallbackUserId = normalizeSlackUserId(env.SLACK_FALLBACK_USER_ID)
    const mergedByGithubHandle = env.MERGED_BY_GITHUB_HANDLE
    if (!mergedByGithubHandle) {
        log.info(`Slack user resolution: github=(missing), resolved=${fallbackUserId} (fallback)`)
        return fallbackUserId
    }

    const normalizedHandle = normalizeGithubHandle(mergedByGithubHandle)
    if (!normalizedHandle) {
        log.info(`Slack user resolution: github=(empty), resolved=${fallbackUserId} (fallback)`)
        return fallbackUserId
    }

    const mapString = env.GH_TO_SLACK_MAP?.trim()
    if (!mapString) {
        log.info(
            `Slack user resolution: github=${normalizedHandle}, mapped=(none, GH_TO_SLACK_MAP unset), resolved=${fallbackUserId} (fallback)`
        )
        return fallbackUserId
    }

    try {
        const mapping = parseGithubToSlackMap(mapString)
        const mappedMention = mapping[normalizedHandle]
        const resolvedMention = mappedMention ?? fallbackUserId
        log.info(
            `Slack user resolution: github=${normalizedHandle}, mapped=${mappedMention ?? "(none)"}, resolved=${resolvedMention}`
        )
        return resolvedMention
    } catch (err) {
        log.error(`Invalid GH_TO_SLACK_MAP: ${err instanceof Error ? err.message : String(err)}`)
        log.info(
            `Slack user resolution: github=${normalizedHandle}, mapped=(invalid map), resolved=${fallbackUserId} (fallback)`
        )
        return fallbackUserId
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
        slackUserMention: resolveSlackUserMention(env),
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
