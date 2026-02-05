import { defineConfig } from "tsup"

export default defineConfig([
    // CLI binary
    {
        entry: { cli: "src/index.ts" },
        format: ["esm"],
        target: "node18",
        clean: true,
        banner: {
            js: "#!/usr/bin/env node",
        },
    },
    // Library exports
    {
        entry: { index: "src/lib.ts" },
        format: ["esm"],
        target: "node18",
        dts: true,
    },
])
