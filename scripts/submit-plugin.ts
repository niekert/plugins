#!/usr/bin/env yarn tsx

/**
 * Plugin Submission Script
 *
 * Builds, packs, and submits a plugin to the Framer marketplace.
 * Automatically generates changelog from git diff using AI.
 *
 * Usage: yarn tsx scripts/submit-plugin.ts
 *
 * Environment Variables:
 *   PLUGIN_PATH         - Path to the plugin directory (required)
 *   CHANGELOG           - Changelog text (optional - if empty, generates with AI)
 *   OPENROUTER_API_KEY  - OpenRouter API key for changelog generation (required if CHANGELOG is empty)
 *   SESSION_TOKEN       - Framer session cookie (required unless DRY_RUN)
 *   FRAMER_ADMIN_SECRET - Framer admin API key (required unless DRY_RUN)
 *   SLACK_WEBHOOK_URL   - Slack workflow webhook for notifications (optional)
 *   RETOOL_URL          - Retool dashboard URL for Slack notifications (optional)
 *   FRAMER_ENV          - Environment: "production" or "development" (default: production)
 *   DRY_RUN             - Skip submission and tagging when "true" (optional)
 *   OPENROUTER_MODEL    - Model to use (default: anthropic/claude-sonnet-4)
 *   REPO_ROOT           - Root of the git repository (default: parent of scripts/)
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { runBuildScript, zipDistFolder } from "framer-plugin-tools"

// ============================================================================
// Types
// ============================================================================

interface FramerJson {
    id: string
    name: string
    modes: string[]
    icon: string
}

interface PluginPackageJson {
    name: string
    version?: string
}

interface PluginInfo {
    id: string
    name: string
    workspaceName: string
    path: string
    zipPath: string
}

interface SubmissionResponse {
    version: string
    versionId: string
    pluginId: string
    slug: string
}

interface Config {
    pluginPath: string
    changelog: string | undefined
    sessionToken: string | undefined
    framerAdminSecret: string | undefined
    slackWebhookUrl: string | undefined
    retoolUrl: string | undefined
    framerEnv: FramerEnv
    urls: EnvironmentUrls
    dryRun: boolean
    openrouterApiKey: string | undefined
    openrouterModel: string
}

interface AccessTokenResponse {
    accessToken: string
    expiresAt: string
    expiresInSeconds: number
}

interface PluginVersion {
    id: string
    name: string
    modes: string[]
    icon: string | null
    prettyVersion: number
    status: string
    releaseNotes: string | null
    reviewedAt: string | null
    url: string
    createdAt: string
}

interface Plugin {
    id: string
    manifestId: string
    description: string | null
    ownerType: string
    ownerId: string
    createdAt: string
    updatedAt: string
    external: boolean
    currentVersion: PluginVersion | null
    lastCreatedVersion: PluginVersion | null
}

interface PluginsResponse {
    plugins: Plugin[]
}

// ============================================================================
// Environment Configuration
// ============================================================================

type FramerEnv = "production" | "development"

interface EnvironmentUrls {
    apiBase: string
    creatorsApiBase: string
    framerAppUrl: string
    marketplaceBaseUrl: string
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
        marketplaceBaseUrl: "https://marketplace.development.framer.com",
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
    const pluginPath = process.env.PLUGIN_PATH
    const changelog = process.env.CHANGELOG?.trim() ?? undefined
    const sessionToken = process.env.SESSION_TOKEN
    const framerAdminSecret = process.env.FRAMER_ADMIN_SECRET
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL
    const retoolUrl = process.env.RETOOL_URL // Optional - only needed for Slack notifications
    const dryRun = process.env.DRY_RUN === "true"
    const openrouterApiKey = process.env.OPENROUTER_API_KEY
    const openrouterModel = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4"

    // Environment configuration
    const framerEnvInput = process.env.FRAMER_ENV ?? "production"
    if (framerEnvInput !== "production" && framerEnvInput !== "development") {
        throw new Error(`Invalid FRAMER_ENV: "${framerEnvInput}". Must be "production" or "development".`)
    }
    const framerEnv: FramerEnv = framerEnvInput
    const envUrls = ENVIRONMENT_URLS[framerEnv]

    const missing: string[] = []

    if (!pluginPath) missing.push("PLUGIN_PATH")

    // Only require OpenRouter API key if changelog is not provided
    if (!changelog && !openrouterApiKey) {
        missing.push("OPENROUTER_API_KEY (required when CHANGELOG is empty)")
    }

    if (!dryRun) {
        if (!sessionToken) missing.push("SESSION_TOKEN")
        if (!framerAdminSecret) missing.push("FRAMER_ADMIN_SECRET")
    }

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
    }

    // TypeScript can't narrow based on the missing array check, so add explicit guard
    if (!pluginPath) {
        throw new Error("PLUGIN_PATH is required")
    }

    return {
        pluginPath: resolve(pluginPath),
        changelog,
        sessionToken,
        framerAdminSecret,
        slackWebhookUrl,
        retoolUrl,
        framerEnv,
        urls: envUrls,
        dryRun,
        openrouterApiKey,
        openrouterModel,
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

    const data = (await response.json()) as AccessTokenResponse
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

    const data = (await response.json()) as PluginsResponse
    return data.plugins
}

// ============================================================================
// Git Operations
// ============================================================================

function getLastTagForPlugin(pluginName: string, repoRoot: string): string | null {
    const tagPrefix = `${pluginName.toLowerCase().replace(/\s+/g, "-")}-v`

    try {
        // Get all tags matching the plugin prefix, sorted by version
        const tags = execSync(`git tag -l "${tagPrefix}*" --sort=-v:refname`, {
            cwd: repoRoot,
            encoding: "utf-8",
        })
            .trim()
            .split("\n")
            .filter(Boolean)

        if (tags.length === 0) {
            return null
        }

        const latestTag = tags[0]
        if (!latestTag) {
            return null
        }
        log.info(`Found ${tags.length} existing tag(s) for ${pluginName}`)
        log.info(`Latest tag: ${latestTag}`)

        return latestTag
    } catch {
        return null
    }
}

function getGitDiff(pluginPath: string, sinceTag: string | null, repoRoot: string): string {
    const relativePath = pluginPath.replace(repoRoot + "/", "")

    try {
        let diff: string

        if (sinceTag) {
            // Diff since last tag
            diff = execSync(`git diff ${sinceTag}..HEAD -- "${relativePath}"`, {
                cwd: repoRoot,
                encoding: "utf-8",
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
            })
        } else {
            // No previous tag - get all commits for this plugin
            // Use the first commit that touched this directory
            const firstCommit = execSync(
                `git log --oneline --diff-filter=A -- "${relativePath}" | tail -1 | cut -d' ' -f1`,
                {
                    cwd: repoRoot,
                    encoding: "utf-8",
                }
            ).trim()

            if (firstCommit) {
                diff = execSync(`git diff ${firstCommit}^..HEAD -- "${relativePath}"`, {
                    cwd: repoRoot,
                    encoding: "utf-8",
                    maxBuffer: 10 * 1024 * 1024,
                })
            } else {
                // Fallback: just show current state
                diff = execSync(`git diff --no-index /dev/null "${relativePath}" || true`, {
                    cwd: repoRoot,
                    encoding: "utf-8",
                    maxBuffer: 10 * 1024 * 1024,
                })
            }
        }

        return diff.trim()
    } catch (error) {
        throw new Error(`Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function getCommitMessages(pluginPath: string, sinceTag: string | null, repoRoot: string): string {
    const relativePath = pluginPath.replace(repoRoot + "/", "")

    try {
        let messages: string

        if (sinceTag) {
            messages = execSync(`git log ${sinceTag}..HEAD --oneline -- "${relativePath}"`, {
                cwd: repoRoot,
                encoding: "utf-8",
            })
        } else {
            messages = execSync(`git log --oneline -- "${relativePath}"`, {
                cwd: repoRoot,
                encoding: "utf-8",
            })
        }

        return messages.trim()
    } catch {
        return ""
    }
}

// ============================================================================
// AI Changelog Generation
// ============================================================================

interface OpenRouterResponse {
    choices: {
        message: {
            content: string
        }
    }[]
}

async function generateChangelog(
    pluginName: string,
    diff: string,
    commitMessages: string,
    config: Config
): Promise<string> {
    // Truncate diff if too large (keep first 50k chars)
    const maxDiffLength = 50000
    const truncatedDiff =
        diff.length > maxDiffLength ? diff.slice(0, maxDiffLength) + "\n\n[... diff truncated ...]" : diff

    const prompt = `Generate a concise, user-facing changelog for a Framer plugin called "${pluginName}".

Based on the following git diff and commit messages, create a changelog that:
- Uses bullet points (- )
- Focuses on FEATURES and FIXES that users care about, not implementation details
- Groups related changes into ONE bullet point (e.g., if multiple commits implement "secondary locations", that's ONE feature)
- Is written in past tense ("Added", "Fixed", "Improved")
- Is very concise - typically 1-3 bullet points, max 5 for major releases
- Avoids technical jargon - write for end users, not developers

Bad example (too granular):
- Added Locations data source
- Added collection selector dropdown
- Fixed slug generation
- Enhanced collection reference handling

Good example (grouped by feature):
- Added support for secondary job locations
- Fixed slug generation for international city names

Commit messages:
${commitMessages || "(no commit messages)"}

Git diff:
${truncatedDiff || "(no diff available)"}

Respond with ONLY the changelog bullet points, no other text.`

    log.info(`Generating changelog with ${config.openrouterModel}...`)

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(config.openrouterApiKey)}`,
        },
        body: JSON.stringify({
            model: config.openrouterModel,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1000,
        }),
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}\n${errorText}`)
    }

    const data = (await response.json()) as OpenRouterResponse
    const changelog = data.choices[0]?.message.content.trim()

    if (!changelog) {
        throw new Error("Failed to generate changelog: empty response from AI")
    }

    return changelog
}

// ============================================================================
// Plugin Operations
// ============================================================================

function loadPluginInfo(pluginPath: string): PluginInfo {
    const framerJsonPath = join(pluginPath, "framer.json")
    const packageJsonPath = join(pluginPath, "package.json")

    if (!existsSync(framerJsonPath)) {
        throw new Error(`framer.json not found at ${framerJsonPath}`)
    }

    if (!existsSync(packageJsonPath)) {
        throw new Error(`package.json not found at ${packageJsonPath}`)
    }

    const framerJson = JSON.parse(readFileSync(framerJsonPath, "utf-8")) as FramerJson
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PluginPackageJson

    if (!framerJson.id) {
        throw new Error("framer.json is missing 'id' field")
    }

    if (!framerJson.name) {
        throw new Error("framer.json is missing 'name' field")
    }

    if (!packageJson.name) {
        throw new Error("package.json is missing 'name' field")
    }

    return {
        id: framerJson.id,
        name: framerJson.name,
        workspaceName: packageJson.name,
        path: pluginPath,
        zipPath: join(pluginPath, "plugin.zip"),
    }
}

async function packPlugin(pluginPath: string): Promise<string> {
    log.info("Building plugin...")
    await runBuildScript(pluginPath)

    log.info("Creating plugin.zip...")
    const zipPath = zipDistFolder({
        cwd: pluginPath,
        distPath: "dist",
        zipFileName: "plugin.zip",
    })

    log.success(`Created: ${zipPath}`)
    return zipPath
}

// ============================================================================
// Framer API Submission
// ============================================================================

async function submitPlugin(
    pluginInfo: PluginInfo,
    plugin: Plugin,
    changelog: string,
    config: Config
): Promise<SubmissionResponse> {
    if (!config.sessionToken || !config.framerAdminSecret) {
        throw new Error("Session token and Framer admin secret are required for submission")
    }

    const url = `${config.urls.creatorsApiBase}/api/admin/plugin/${plugin.id}/versions/`

    log.info(`Submitting to: ${url}`)

    const zipBuffer = readFileSync(pluginInfo.zipPath)
    const blob = new Blob([zipBuffer], { type: "application/zip" })

    const formData = new FormData()
    formData.append("file", blob, "plugin.zip")
    formData.append("content", changelog)

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

    const result = (await response.json()) as SubmissionResponse
    log.success(`Submitted! Version: ${result.version}`)

    return result
}

// ============================================================================
// Git Tagging
// ============================================================================

function createGitTag(pluginName: string, version: string, changelog: string, repoRoot: string): void {
    const tagName = `${pluginName.toLowerCase().replace(/\s+/g, "-")}-v${version}`

    log.info(`Creating git tag: ${tagName}`)

    try {
        // Create annotated tag with changelog as message
        const escapedChangelog = changelog.replace(/'/g, "'\\''")
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
    webhookUrl: string,
    pluginInfo: PluginInfo,
    submissionResult: SubmissionResponse,
    changelog: string,
    config: Config
): Promise<void> {
    const payload: SlackWorkflowPayload = {
        pluginName: pluginInfo.name,
        pluginVersion: submissionResult.version,
        marketplacePreviewUrl: `${config.urls.marketplaceBaseUrl}/plugins/${submissionResult.slug}/review`,
        pluginReviewUrl: `${config.urls.framerAppUrl}/projects/new?plugin=${submissionResult.pluginId}&pluginVersion=${submissionResult.versionId}`,
        changelog,
    }

    // Only include retoolUrl if configured
    if (config.retoolUrl) {
        payload.retoolUrl = config.retoolUrl
    }

    try {
        const response = await fetch(webhookUrl, {
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

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    console.log("=".repeat(60))
    console.log("Framer Plugin Submission Script")
    console.log("=".repeat(60))

    // 1. Load configuration
    log.step("Configuration")
    const config = getConfig()
    let pluginInfo: PluginInfo | undefined
    let changelog = ""
    // REPO_ROOT can be overridden when script is run from a different repo
    const repoRoot = process.env.REPO_ROOT ?? resolve(__dirname, "..")

    try {
        log.info(`Plugin path: ${config.pluginPath}`)
        log.info(`Environment: ${config.framerEnv}`)
        log.info(`API base: ${config.urls.creatorsApiBase}`)
        log.info(`Dry run: ${String(config.dryRun)}`)
        log.info(`AI model: ${config.openrouterModel}`)

        // 2. Validate plugin path exists
        if (!existsSync(config.pluginPath)) {
            throw new Error(`Plugin path does not exist: ${config.pluginPath}`)
        }

        // 3. Install plugin dependencies
        log.step("Installing Plugin Dependencies")
        try {
            execSync("yarn install", {
                cwd: config.pluginPath,
                stdio: "inherit",
            })
            log.success("Dependencies installed")
        } catch (error) {
            throw new Error(`Yarn install failed: ${error instanceof Error ? error.message : String(error)}`)
        }

        // 4. Load plugin info
        log.step("Loading Plugin Info")
        pluginInfo = loadPluginInfo(config.pluginPath)
        log.info(`Name: ${pluginInfo.name}`)
        log.info(`Manifest ID: ${pluginInfo.id}`)
        log.info(`Workspace: ${pluginInfo.workspaceName}`)

        // 5. Fetch user's plugins to find the database plugin ID
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
        log.info(`Found plugin with database ID: ${plugin.id}`)

        // 6. Get or generate changelog
        if (config.changelog) {
            log.step("Using Provided Changelog")
            changelog = config.changelog
            log.info(`Changelog:\n${changelog}`)
        } else {
            log.step("Analyzing Changes")
            const lastTag = getLastTagForPlugin(pluginInfo.name, repoRoot)

            if (lastTag) {
                log.info(`Last release: ${lastTag}`)
                const diff = getGitDiff(config.pluginPath, lastTag, repoRoot)
                const commitMessages = getCommitMessages(config.pluginPath, lastTag, repoRoot)

                if (!diff && !commitMessages) {
                    throw new Error("No changes detected since last release. Nothing to submit.")
                }

                log.info(`Diff size: ${diff.length} chars`)
                log.info(`Commits: ${commitMessages.split("\n").filter(Boolean).length}`)

                // Generate changelog with AI
                log.step("Generating Changelog with AI")
                changelog = await generateChangelog(pluginInfo.name, diff, commitMessages, config)
                log.info(`Generated changelog:\n${changelog}`)
            } else {
                log.info("No previous release found - this will be the first version")
                changelog = "First release"
            }
        }

        // 7. Build & Pack the plugin
        log.step("Building & Packing Plugin")
        await packPlugin(config.pluginPath)

        // 8. Submit (unless dry run)
        let submissionResult: SubmissionResponse | undefined

        if (config.dryRun) {
            log.step("DRY RUN - Skipping Submission")
            log.info("Plugin is built and packed. Would submit to API in real run.")
            log.info(`Would submit with changelog:\n${changelog}`)
        } else {
            log.step("Submitting to Framer API")
            submissionResult = await submitPlugin(pluginInfo, plugin, changelog, config)
        }

        // 9. Create git tag (unless dry run)
        if (config.dryRun) {
            log.step("DRY RUN - Skipping Git Tag")
            log.info("Would create git tag in real run.")
        } else if (submissionResult) {
            log.step("Creating Git Tag")
            createGitTag(pluginInfo.name, submissionResult.version, changelog, repoRoot)
        }

        // 10. Send Slack notification (only on successful submission)
        if (config.slackWebhookUrl && submissionResult) {
            log.step("Sending Slack Notification")
            await sendSlackNotification(config.slackWebhookUrl, pluginInfo, submissionResult, changelog, config)
        }

        console.log("\n" + "=".repeat(60))
        log.success("Done!")
        console.log("=".repeat(60))
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error(errorMessage)
        process.exit(1)
    }
}

void main()
