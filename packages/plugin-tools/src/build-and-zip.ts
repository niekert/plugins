import AdmZip from "adm-zip"
import { exec } from "child_process"
import fs from "fs"
import path from "path"

export interface BuildAndZipOptions {
    /** Working directory (defaults to process.cwd()) */
    cwd?: string
    /** Skip the build step, only create zip from existing dist */
    skipBuild?: boolean
    /** Suppress console output */
    silent?: boolean
}

export interface BuildAndZipResult {
    zipPath: string
}

interface ZipDistFolderOptions {
    cwd: string
    distPath: string
    zipFileName: string
}

export function zipDistFolder(options: ZipDistFolderOptions): string {
    const distPath = path.join(options.cwd, options.distPath)

    if (!fs.existsSync(distPath)) {
        throw new Error(
            `The 'dist' directory does not exist at ${distPath}. Please make sure to build the Plugin first and that the build output is in the 'dist' directory.`
        )
    }

    const zipPath = path.join(options.cwd, options.zipFileName)

    const zip = new AdmZip()
    zip.addLocalFolder(distPath)
    zip.writeZip(zipPath)

    return zipPath
}

export function runBuildScript(cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const buildProcess = exec("npm run build", { cwd })

        buildProcess.stdout?.on("data", (data: string) => process.stdout.write(data))
        buildProcess.stderr?.on("data", (data: string) => process.stderr.write(data))

        buildProcess.on("exit", code => {
            if (code !== 0) {
                reject(new Error(`Failed to build Plugin. Exit code: ${code ?? "unknown"}`))
                return
            }
            resolve()
        })

        buildProcess.on("error", err => {
            reject(new Error(`Failed to start build process: ${err.message}`))
        })
    })
}
