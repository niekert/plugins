import { runBuildScript, zipDistFolder } from "./build-and-zip"

async function run() {
    const [, , command] = process.argv
    switch (command) {
        case "prepare":
        case "pack": {
            const cwd = process.cwd()

            console.log("Building your Plugin…")
            await runBuildScript(cwd)
            const zipFileName = "plugin.zip"

            console.log(`Creating ${zipFileName} file…`)

            zipDistFolder({
                cwd,
                distPath: "dist",
                zipFileName,
            })

            console.log(
                `\n⚡️ ${zipFileName} file has been created in ${cwd} \n Submit your Plugin on the Framer Marketplace: https://www.framer.com/marketplace/dashboard/plugins/`
            )

            break
        }
        default:
            console.log(`Unknown command: ${command ?? "unknown"}`)
            process.exit(1)
    }
}

run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
