#!/usr/bin/env npx tsx

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
 *   SLACK_WEBHOOK_URL   - Slack webhook for notifications (optional)
 *   CREATORS_API_BASE   - API base URL (default: https://creators.framer.com)
 *   DRY_RUN             - Skip submission and tagging when "true" (optional)
 *   OPENROUTER_MODEL    - Model to use (default: anthropic/claude-sonnet-4)
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve, basename } from "node:path"
import OpenAI from "openai"

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
    creatorsApiBase: string
    dryRun: boolean
    openrouterApiKey: string | undefined
    openrouterModel: string
}

// ============================================================================
// Logging
// ============================================================================

const log = {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    success: (msg: string) => console.log(`[SUCCESS] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`),
    step: (msg: string) => console.log(`\n=== ${msg} ===`),
}

// ============================================================================
// Configuration
// ============================================================================

function getConfig(): Config {
    const pluginPath = process.env.PLUGIN_PATH
    const changelog = process.env.CHANGELOG?.trim() || undefined
    const sessionToken = process.env.SESSION_TOKEN
    const framerAdminSecret = process.env.FRAMER_ADMIN_SECRET
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL
    const creatorsApiBase = process.env.CREATORS_API_BASE || "https://creators.framer.com"
    const dryRun = process.env.DRY_RUN === "true"
    const openrouterApiKey = process.env.OPENROUTER_API_KEY
    const openrouterModel = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4"

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

    return {
        pluginPath: resolve(pluginPath!),
        changelog,
        sessionToken,
        framerAdminSecret,
        slackWebhookUrl,
        creatorsApiBase,
        dryRun,
        openrouterApiKey,
        openrouterModel,
    }
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

        log.info(`Found ${tags.length} existing tag(s) for ${pluginName}`)
        log.info(`Latest tag: ${tags[0]}`)

        return tags[0]
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

async function generateChangelog(
    pluginName: string,
    diff: string,
    commitMessages: string,
    config: Config
): Promise<string> {
    const openai = new OpenAI({
        apiKey: config.openrouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
    })

    // Truncate diff if too large (keep first 50k chars)
    const maxDiffLength = 50000
    const truncatedDiff = diff.length > maxDiffLength ? diff.slice(0, maxDiffLength) + "\n\n[... diff truncated ...]" : diff

    const prompt = `Generate a concise, user-facing changelog for a Framer plugin called "${pluginName}".

Based on the following git diff and commit messages, create a changelog that:
- Uses bullet points (- )
- Focuses on features, fixes, and improvements users care about
- Avoids technical implementation details
- Is written in past tense ("Added", "Fixed", "Improved")
- Groups related changes together
- Is concise (ideally 3-7 bullet points)

If the changes are minimal or only internal, still provide at least one user-facing summary.

Commit messages:
${commitMessages || "(no commit messages)"}

Git diff:
${truncatedDiff || "(no diff available)"}

Respond with ONLY the changelog bullet points, no other text.`

    log.info(`Generating changelog with ${config.openrouterModel}...`)

    const response = await openai.chat.completions.create({
        model: config.openrouterModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
    })

    const changelog = response.choices[0]?.message?.content?.trim()

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

function buildPlugin(workspaceName: string, repoRoot: string): void {
    log.info(`Building ${workspaceName}...`)

    try {
        execSync(`yarn workspace ${workspaceName} build`, {
            cwd: repoRoot,
            stdio: "inherit",
        })
        log.success("Build completed")
    } catch (error) {
        throw new Error(`Build failed: ${error instanceof Error ? error.message : String(error)}`)
    }
}

function packPlugin(pluginPath: string): string {
    log.info("Packing plugin...")

    try {
        execSync("npx framer-plugin-tools@latest pack", {
            cwd: pluginPath,
            stdio: "inherit",
        })

        const zipPath = join(pluginPath, "plugin.zip")

        if (!existsSync(zipPath)) {
            throw new Error(`Expected plugin.zip not found at ${zipPath}`)
        }

        log.success(`Created: ${zipPath}`)
        return zipPath
    } catch (error) {
        throw new Error(`Pack failed: ${error instanceof Error ? error.message : String(error)}`)
    }
}

// ============================================================================
// Framer API Submission
// ============================================================================

async function submitPlugin(
    pluginInfo: PluginInfo,
    changelog: string,
    config: Config
): Promise<SubmissionResponse> {
    const url = `${config.creatorsApiBase}/api/admin/plugin/${pluginInfo.id}/versions/`

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

interface SlackBlock {
    type: string
    text?: { type: string; text: string }
}

interface SlackMessage {
    text: string
    blocks?: SlackBlock[]
}

async function sendSlackNotification(
    webhookUrl: string,
    pluginInfo: PluginInfo,
    changelog: string,
    success: boolean,
    version?: string,
    error?: string,
    dryRun?: boolean
): Promise<void> {
    const prefix = dryRun ? "[DRY RUN] " : ""

    const message: SlackMessage = success
        ? {
              text: `${prefix}Plugin submitted: ${pluginInfo.name}${version ? ` v${version}` : ""}`,
              blocks: [
                  {
                      type: "section",
                      text: {
                          type: "mrkdwn",
                          text: `*${prefix}Plugin submitted successfully!*\n\n*Name:* ${pluginInfo.name}${version ? `\n*Version:* ${version}` : ""}`,
                      },
                  },
                  {
                      type: "section",
                      text: {
                          type: "mrkdwn",
                          text: `*Changelog:*\n${changelog}`,
                      },
                  },
              ],
          }
        : {
              text: `Plugin submission failed: ${pluginInfo.name}`,
              blocks: [
                  {
                      type: "section",
                      text: {
                          type: "mrkdwn",
                          text: `*Plugin submission failed!*\n\n*Name:* ${pluginInfo.name}`,
                      },
                  },
                  {
                      type: "section",
                      text: {
                          type: "mrkdwn",
                          text: `*Error:*\n\`\`\`${error}\`\`\``,
                      },
                  },
              ],
          }

    try {
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
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

    let config: Config
    let pluginInfo: PluginInfo
    let changelog: string = ""
    // REPO_ROOT can be overridden when script is run from a different repo
    const repoRoot = process.env.REPO_ROOT || resolve(__dirname, "..")

    try {
        // 1. Load configuration
        log.step("Configuration")
        config = getConfig()
        log.info(`Plugin path: ${config.pluginPath}`)
        log.info(`API base: ${config.creatorsApiBase}`)
        log.info(`Dry run: ${config.dryRun}`)
        log.info(`AI model: ${config.openrouterModel}`)

        // 2. Validate plugin path exists
        if (!existsSync(config.pluginPath)) {
            throw new Error(`Plugin path does not exist: ${config.pluginPath}`)
        }

        // 3. Load plugin info
        log.step("Loading Plugin Info")
        pluginInfo = loadPluginInfo(config.pluginPath)
        log.info(`Name: ${pluginInfo.name}`)
        log.info(`ID: ${pluginInfo.id}`)
        log.info(`Workspace: ${pluginInfo.workspaceName}`)

        // 4. Get or generate changelog
        if (config.changelog) {
            log.step("Using Provided Changelog")
            changelog = config.changelog
            log.info(`Changelog:\n${changelog}`)
        } else {
            log.step("Analyzing Changes")
            const lastTag = getLastTagForPlugin(pluginInfo.name, repoRoot)

            if (lastTag) {
                log.info(`Last release: ${lastTag}`)
            } else {
                log.info("No previous release found - this will be the first version")
            }

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
        }

        // 6. Build the plugin
        log.step("Building Plugin")
        buildPlugin(pluginInfo.workspaceName, repoRoot)

        // 7. Pack the plugin
        log.step("Packing Plugin")
        packPlugin(config.pluginPath)

        // 8. Submit (unless dry run)
        let submissionResult: SubmissionResponse | undefined

        if (config.dryRun) {
            log.step("DRY RUN - Skipping Submission")
            log.info("Plugin is built and packed. Would submit to API in real run.")
            log.info(`Would submit with changelog:\n${changelog}`)
        } else {
            log.step("Submitting to Framer API")
            submissionResult = await submitPlugin(pluginInfo, changelog, config)
        }

        // 9. Create git tag (unless dry run)
        if (config.dryRun) {
            log.step("DRY RUN - Skipping Git Tag")
            log.info("Would create git tag in real run.")
        } else if (submissionResult) {
            log.step("Creating Git Tag")
            createGitTag(pluginInfo.name, submissionResult.version, changelog, repoRoot)
        }

        // 10. Send Slack notification
        if (config.slackWebhookUrl) {
            log.step("Sending Slack Notification")
            await sendSlackNotification(
                config.slackWebhookUrl,
                pluginInfo,
                changelog,
                true,
                submissionResult?.version,
                undefined,
                config.dryRun
            )
        }

        console.log("\n" + "=".repeat(60))
        log.success("Done!")
        console.log("=".repeat(60))
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error(errorMessage)

        // Send failure notification
        if (config!?.slackWebhookUrl && !config!?.dryRun) {
            try {
                await sendSlackNotification(
                    config!.slackWebhookUrl,
                    pluginInfo! || { id: "unknown", name: "unknown", workspaceName: "unknown", path: "", zipPath: "" },
                    changelog || "",
                    false,
                    undefined,
                    errorMessage,
                    false
                )
            } catch {
                log.error("Failed to send failure notification to Slack")
            }
        }

        process.exit(1)
    }
}

main()
