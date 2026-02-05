#!/usr/bin/env yarn tsx

/**
 * Plugin Submission Script
 *
 * Builds, packs, and submits a plugin to the Framer marketplace.
 *
 * Usage: yarn tsx scripts/submit-plugin.ts
 *
 * Environment Variables:
 *   PLUGIN_PATH         - Path to the plugin directory (required)
 *   CHANGELOG           - Changelog text (required)
 *   SESSION_TOKEN       - Framer session cookie (required unless DRY_RUN)
 *   FRAMER_ADMIN_SECRET - Framer admin API key (required unless DRY_RUN)
 *   SLACK_WEBHOOK_URL   - Slack workflow webhook for success notifications (optional)
 *   SLACK_ERROR_WEBHOOK_URL - Slack workflow webhook for error notifications (optional)
 *   RETOOL_URL          - Retool dashboard URL for Slack notifications (optional)
 *   GITHUB_RUN_URL      - GitHub Actions run URL for error notifications (optional)
 *   FRAMER_ENV          - Environment: "production" or "development" (default: production)
 *   DRY_RUN             - Skip submission and tagging when "true" (optional)
 *   REPO_ROOT           - Root of the git repository (default: parent of scripts/)
 */

import { runBuildScript, zipDistFolder } from "framer-plugin-tools"
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import * as v from "valibot"

// ============================================================================
// Schemas - Environment Variables
// ============================================================================

const FramerEnvSchema = v.picklist(["production", "development"])

const EnvSchema = v.object({
    PLUGIN_PATH: v.pipe(v.string(), v.minLength(1)),
    CHANGELOG: v.pipe(v.string(), v.minLength(1)),
    SESSION_TOKEN: v.optional(v.string()),
    FRAMER_ADMIN_SECRET: v.optional(v.string()),
    SLACK_WEBHOOK_URL: v.optional(v.string()),
    SLACK_ERROR_WEBHOOK_URL: v.optional(v.string()),
    RETOOL_URL: v.optional(v.string()),
    GITHUB_RUN_URL: v.optional(v.string()),
    FRAMER_ENV: v.optional(FramerEnvSchema, "production"),
    DRY_RUN: v.optional(v.string()),
    REPO_ROOT: v.optional(v.string()),
})

// ============================================================================
// Schemas - API Responses
// ============================================================================

const AccessTokenResponseSchema = v.object({
    accessToken: v.string(),
    expiresAt: v.string(),
    expiresInSeconds: v.number(),
})

const PluginVersionSchema = v.object({
    id: v.string(),
    name: v.string(),
    modes: v.array(v.string()),
    icon: v.nullable(v.string()),
    prettyVersion: v.number(),
    status: v.string(),
    releaseNotes: v.nullable(v.string()),
    reviewedAt: v.nullable(v.string()),
    url: v.string(),
    createdAt: v.string(),
})

const PluginSchema = v.object({
    id: v.string(),
    manifestId: v.string(),
    description: v.nullable(v.string()),
    ownerType: v.string(),
    ownerId: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
    external: v.boolean(),
    currentVersion: v.nullable(PluginVersionSchema),
    lastCreatedVersion: v.nullable(PluginVersionSchema),
})
type Plugin = v.InferOutput<typeof PluginSchema>

const PluginsResponseSchema = v.object({
    plugins: v.array(PluginSchema),
})

const SubmissionResponseSchema = v.object({
    version: v.number(),
    // FIXME: THIS SHOULD BE DEPLOYED:
    // SEE: https://github.com/framer/creators/pull/2487/files
    versionId: v.fallback(v.string(), ""),
    internalPluginId: v.string(),
    slug: v.string(),
})
type SubmissionResponse = v.InferOutput<typeof SubmissionResponseSchema>

// ============================================================================
// Schemas - File Contents
// ============================================================================

const FramerJsonSchema = v.object({
    id: v.string(),
    name: v.string(),
})

const PluginPackageJsonSchema = v.object({
    name: v.string(),
})

// ============================================================================
// Types
// ============================================================================

interface PluginInfo {
    id: string
    name: string
    workspaceName: string
    path: string
    zipPath: string
}

type FramerEnv = v.InferOutput<typeof FramerEnvSchema>

interface EnvironmentUrls {
    apiBase: string
    creatorsApiBase: string
    framerAppUrl: string
    marketplaceBaseUrl: string
}

interface Config {
    pluginPath: string
    pluginFileName: string
    changelog: string
    sessionToken: string | undefined
    framerAdminSecret: string | undefined
    slackWebhookUrl: string | undefined
    errorWebhookUrl: string | undefined
    retoolUrl: string | undefined
    githubRunUrl: string | undefined
    framerEnv: FramerEnv
    urls: EnvironmentUrls
    dryRun: boolean
}

const ENVIRONMENT_URLS: Record<FramerEnv, EnvironmentUrls> = {
    production: {
        apiBase: "https://api.framer.com",
        creatorsApiBase: "https://framer.com/marketplace",
        framerAppUrl: "https://framer.com",
        marketplaceBaseUrl: "https://framer.com/marketplace",
    },
    development: {
        apiBase: "https://api.development.framer.com",
        creatorsApiBase: "https://marketplace.development.framer.com",
        framerAppUrl: "https://development.framer.com",
        marketplaceBaseUrl: "https://marketplace.development.framer.com/marketplace",
    },
}

// ============================================================================
// Logging
// ============================================================================

const log = {
    info: (msg: string) => {
        console.log(`[INFO] ${msg}`)
    },
    success: (msg: string) => {
        console.log(`[SUCCESS] ${msg}`)
    },
    error: (msg: string) => {
        console.error(`[ERROR] ${msg}`)
    },
    step: (msg: string) => {
        console.log(`\n=== ${msg} ===`)
    },
}

// ============================================================================
// Configuration
// ============================================================================

function getConfig(): Config {
    const dryRun = process.env.DRY_RUN === "true"

    // Build the schema dynamically based on dryRun
    const schema = dryRun
        ? EnvSchema
        : v.object({
              ...EnvSchema.entries,
              SESSION_TOKEN: v.pipe(v.string(), v.minLength(1)),
              FRAMER_ADMIN_SECRET: v.pipe(v.string(), v.minLength(1)),
          })

    const result = v.safeParse(schema, process.env)

    if (!result.success) {
        const issues = result.issues.map(issue => {
            const path = issue.path?.map(p => p.key).join(".") ?? "unknown"
            return `${path}: ${issue.message}`
        })
        throw new Error(`Invalid environment variables:\n${issues.join("\n")}`)
    }

    const env = result.output
    const framerEnv = env.FRAMER_ENV ?? "production"

    return {
        pluginPath: resolve(env.PLUGIN_PATH),
        pluginFileName: "plugin.zip",
        changelog: env.CHANGELOG.trim(),
        sessionToken: env.SESSION_TOKEN,
        framerAdminSecret: env.FRAMER_ADMIN_SECRET,
        slackWebhookUrl: env.SLACK_WEBHOOK_URL,
        errorWebhookUrl: env.SLACK_ERROR_WEBHOOK_URL,
        retoolUrl: env.RETOOL_URL,
        githubRunUrl: env.GITHUB_RUN_URL,
        framerEnv,
        urls: ENVIRONMENT_URLS[framerEnv],
        dryRun,
    }
}

// ============================================================================
// Framer API Operations
// ============================================================================

async function getAccessToken(config: Config): Promise<string> {
    if (!config.sessionToken) {
        throw new Error("Session token is required")
    }

    const response = await fetch(`${config.urls.apiBase}/auth/web/access-token`, {
        headers: {
            Cookie: `session=${config.sessionToken}`,
        },
    })

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error("Session expired. Please update your SESSION_TOKEN.")
        }
        throw new Error(`Failed to get access token: ${response.statusText}`)
    }

    const data = v.parse(AccessTokenResponseSchema, await response.json())
    return data.accessToken
}

async function fetchMyPlugins(config: Config): Promise<Plugin[]> {
    const accessToken = await getAccessToken(config)

    const response = await fetch(`${config.urls.apiBase}/site/v1/plugins/me`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error("Session expired. Please update your SESSION_TOKEN.")
        }
        throw new Error(`Failed to fetch plugins: ${response.statusText}`)
    }

    const data = v.parse(PluginsResponseSchema, await response.json())
    return data.plugins
}

// ============================================================================
// Plugin Operations
// ============================================================================

function loadPluginInfo({ pluginPath, pluginFileName }: Config): PluginInfo {
    const framerJsonPath = join(pluginPath, "framer.json")
    const packageJsonPath = join(pluginPath, "package.json")

    if (!existsSync(framerJsonPath)) {
        throw new Error(`framer.json not found at ${framerJsonPath}`)
    }

    if (!existsSync(packageJsonPath)) {
        throw new Error(`package.json not found at ${packageJsonPath}`)
    }

    const framerJson = v.parse(FramerJsonSchema, JSON.parse(readFileSync(framerJsonPath, "utf-8")))
    const packageJson = v.parse(PluginPackageJsonSchema, JSON.parse(readFileSync(packageJsonPath, "utf-8")))

    return {
        id: framerJson.id,
        name: framerJson.name,
        workspaceName: packageJson.name,
        path: pluginPath,
        zipPath: join(pluginPath, pluginFileName),
    }
}

async function packPlugin({ pluginPath, pluginFileName }: Config): Promise<string> {
    log.info("Building plugin...")
    await runBuildScript(pluginPath)

    log.info("Creating plugin.zip...")
    const zipPath = zipDistFolder({
        cwd: pluginPath,
        distPath: "dist",
        zipFileName: pluginFileName,
    })

    log.success(`Created: ${zipPath}`)
    return zipPath
}

// ============================================================================
// Framer API Submission
// ============================================================================

async function submitPlugin(pluginInfo: PluginInfo, plugin: Plugin, config: Config): Promise<SubmissionResponse> {
    if (!config.sessionToken || !config.framerAdminSecret) {
        throw new Error("Session token and Framer admin secret are required for submission")
    }

    const url = `${config.urls.creatorsApiBase}/api/admin/plugin/${plugin.id}/versions/`

    log.info(`Submitting to: ${url}`)

    const zipBuffer = readFileSync(pluginInfo.zipPath)
    const blob = new Blob([zipBuffer], { type: "application/zip" })

    const formData = new FormData()
    formData.append("file", blob, config.pluginFileName)
    formData.append("content", config.changelog)

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Cookie: `session=${config.sessionToken}`,
            Authorization: `Bearer ${config.framerAdminSecret}`,
        },
        body: formData,
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API submission failed: ${response.status} ${response.statusText}\n${errorText}`)
    }

    const result = v.parse(SubmissionResponseSchema, await response.json())
    log.success(`Submitted! Version: ${result.version}`)

    return result
}

// ============================================================================
// Git Tagging
// ============================================================================

function createGitTag(pluginName: string, version: number, repoRoot: string, config: Config): void {
    const tagName = `${pluginName.toLowerCase().replace(/\s+/g, "-")}-v${version.toString()}`

    log.info(`Creating git tag: ${tagName}`)

    try {
        // Delete existing tag if it exists (e.g., from a rejected submission)
        try {
            execSync(`git tag -d "${tagName}"`, { cwd: repoRoot, stdio: "pipe" })
            execSync(`git push origin --delete "${tagName}"`, { cwd: repoRoot, stdio: "pipe" })
        } catch {
            // Tag doesn't exist, that's fine
        }

        // Create annotated tag with changelog as message
        const escapedChangelog = config.changelog.replace(/'/g, "'\\''")
        execSync(`git tag -a "${tagName}" -m '${escapedChangelog}'`, {
            cwd: repoRoot,
            stdio: "inherit",
        })

        // Push tag
        execSync(`git push origin "${tagName}"`, {
            cwd: repoRoot,
            stdio: "inherit",
        })

        log.success(`Tag ${tagName} created and pushed`)
    } catch (error) {
        // Don't fail the whole process if tagging fails
        log.error(`Failed to create/push tag: ${error instanceof Error ? error.message : String(error)}`)
    }
}

// ============================================================================
// Slack Notifications
// ============================================================================

interface SlackWorkflowPayload {
    pluginName: string
    retoolUrl?: string
    marketplacePreviewUrl: string
    pluginVersion: string
    pluginReviewUrl: string
    changelog: string
}

async function sendSlackNotification(
    pluginInfo: PluginInfo,
    submissionResult: SubmissionResponse,
    config: Config
): Promise<void> {
    const payload: SlackWorkflowPayload = {
        pluginName: pluginInfo.name,
        pluginVersion: submissionResult.version.toString(),
        marketplacePreviewUrl: `${config.urls.marketplaceBaseUrl}/plugins/${submissionResult.slug}/preview`,
        pluginReviewUrl: `${config.urls.framerAppUrl}/projects/new?plugin=${submissionResult.internalPluginId}&pluginVersion=${submissionResult.versionId}`,
        changelog: config.changelog,
        retoolUrl: config.retoolUrl,
    }

    if (!config.slackWebhookUrl) return

    try {
        const response = await fetch(config.slackWebhookUrl, {
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

async function sendErrorNotification(
    errorMessage: string,
    pluginName: string | undefined,
    config: Config
): Promise<void> {
    if (!config.errorWebhookUrl) return

    const payload = {
        githubActionRunUrl: config.githubRunUrl ?? "N/A (not running in GitHub Actions)",
        errorMessage,
        pluginName: pluginName ?? "Unknown",
    }

    try {
        const response = await fetch(config.errorWebhookUrl, {
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

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    console.log("=".repeat(60))
    console.log("Submitting Plugin to Framer Marketplace")
    console.log("=".repeat(60))

    log.step("Configuration")
    const config = getConfig()
    let pluginInfo: PluginInfo | undefined
    // REPO_ROOT can be overridden when script is run from a different repo
    const repoRoot = process.env.REPO_ROOT ?? resolve(__dirname, "..")

    try {
        log.info(`Plugin path: ${config.pluginPath}`)
        log.info(`Environment: ${config.framerEnv}`)
        log.info(`API base: ${config.urls.creatorsApiBase}`)
        log.info(`Dry run: ${String(config.dryRun)}`)

        if (!existsSync(config.pluginPath)) {
            throw new Error(`Plugin path does not exist: ${config.pluginPath}`)
        }

        log.step("Loading Plugin Info")
        pluginInfo = loadPluginInfo(config)
        log.info(`Name: ${pluginInfo.name}`)
        log.info(`Manifest ID: ${pluginInfo.id}`)
        log.info(`Workspace: ${pluginInfo.workspaceName}`)

        // 4. Fetch user's plugins to find the database plugin ID
        log.step("Fetching Plugin from Framer")
        const plugins = await fetchMyPlugins(config)
        const matchedPlugin = plugins.find(p => p.manifestId === pluginInfo?.id)

        if (!matchedPlugin) {
            throw new Error(
                `No plugin found with manifest ID "${pluginInfo.id}". ` +
                    `Make sure you have created this plugin on Framer first.`
            )
        }

        const plugin = matchedPlugin
        log.info(`Found plugin with ID: ${plugin.id}`)

        log.step("Changelog")
        log.info(`Changelog:\n${config.changelog}`)

        log.step("Building & Packing Plugin")
        await packPlugin(config)

        let submissionResult: SubmissionResponse | undefined

        if (config.dryRun) {
            log.step("DRY RUN - Skipping Submission")
            log.info("Plugin is built and packed. Would submit to API in real run.")
            log.info(`Would submit with changelog:\n${config.changelog}`)
        } else {
            log.step("Submitting to Framer API")
            submissionResult = await submitPlugin(pluginInfo, plugin, config)
        }

        if (config.dryRun) {
            log.step("DRY RUN - Skipping Git Tag")
            log.info("Would create git tag in real run.")
        } else if (submissionResult) {
            log.step("Creating Git Tag")
            createGitTag(pluginInfo.name, submissionResult.version, repoRoot, config)
        }

        if (config.slackWebhookUrl && submissionResult) {
            log.step("Sending Slack Notification")
            await sendSlackNotification(pluginInfo, submissionResult, config)
        }

        console.log("\n" + "=".repeat(60))
        log.success("Done!")
        console.log("=".repeat(60))
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error(errorMessage)

        await sendErrorNotification(errorMessage, pluginInfo?.name, config)

        process.exit(1)
    }
}

void main()
