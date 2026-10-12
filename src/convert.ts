#!/usr/bin/env node

import { exportSession, fail, type Options } from "./session.ts";
import { findClaudeSession } from "./claude.ts";

function parseArgs(argv: string[]): Options {
    const args = argv.slice(2);
    let input: string | undefined;
    let outDir = ".llm";
    let comment = "";
    let redactUser = "user";
    let subscription: string | null | undefined;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-o" || a === "--out") {
            outDir = args[++i] ?? fail(`missing value for ${a}`);
        } else if (a === "--comment") {
            comment = args[++i] ?? "";
        } else if (a === "--claude-session") {
            input = findClaudeSession(args[++i] ?? fail(`missing value for ${a}`));
        } else if (a === "--subscription") {
            const plan = args[++i] ?? fail(`missing value for ${a}`);
            subscription = plan === "none" ? null : plan;
        } else if (a === "--redact-user") {
            redactUser = args[++i] ?? fail(`missing value for ${a}`);
        } else if (a === "-h" || a === "--help") {
            process.stdout.write("Usage: pelmeshi <input> | --claude-session <id> [-o <dir>] [--comment <text>] [--redact-user <name>] [--subscription <plan|none>]\n");
            process.exit(0);
        } else if (a.startsWith("-")) {
            fail(`unknown option: ${a}`);
        } else if (input) {
            fail(`unexpected extra argument: ${a}`);
        } else {
            input = a;
        }
    }

    if (!input) fail("missing <input> file (or --claude-session <id>)");
    return { input, outDir, comment, redactUser, subscription };
}

async function main(): Promise<void> {
    const { input, outDir, comment, redactUser, subscription } = parseArgs(process.argv);
    const outFile = await exportSession(input, outDir, comment, redactUser, subscription);
    console.log(outFile);
}

await main();
