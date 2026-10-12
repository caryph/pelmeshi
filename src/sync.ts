import { execFileSync } from "node:child_process";
import {
    cpSync, existsSync, mkdirSync, mkdtempSync,
    readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

const [registryPath, siteRoot] = process.argv.slice(2);
if (!registryPath || !siteRoot) {
    console.error("usage: sync <registry.json> <website-folder>");
    process.exit(1);
}

const projects = JSON.parse(readFileSync(registryPath, "utf8"));

const outBase = join(siteRoot, "logs", "p");
rmSync(outBase, { recursive: true, force: true });
mkdirSync(outBase, { recursive: true });

const index: any = { generated: new Date().toISOString(), projects: [] };

function readPrice(s: any): number {
    if (typeof s.price_usd === "number") return s.price_usd;
    if (typeof s.price === "number") return s.price;
    if (typeof s.price === "string") {
        const n = parseFloat(s.price.replace(/[^0-9.]/g, ""));
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

for (const p of projects) {
    const tmp = mkdtempSync(join(tmpdir(), "pelmeshi-"));
    try {
        execFileSync("git", ["clone", "--depth", "1", "--filter=blob:none",
        "--sparse", `https://github.com/${p.repo}.git`, tmp], { stdio: "pipe" });
        execFileSync("git", ["-C", tmp, "sparse-checkout", "set", ".llm"], { stdio: "pipe" });

        const llmDir = join(tmp, ".llm");
        if (!existsSync(llmDir)) continue;

        const outDir = join(outBase, p.slug);
        mkdirSync(outDir, { recursive: true });

        const sessions = [];
        for (const f of readdirSync(llmDir).sort()) {
            if (!f.endsWith(".json")) continue;
            cpSync(join(llmDir, f), join(outDir, f));
            const s = JSON.parse(readFileSync(join(llmDir, f), "utf8"));
            sessions.push({
                date: f.slice(0, 10),
                url: `/logs/p/${p.slug}/${f}`,
                model: s.model?.name ?? "?",
                price: readPrice(s),
                subscription: s.subscription ?? null,
                tokens: (s.stats?.tokens_in ?? 0)
                    + (s.stats?.tokens_out ?? 0)
                    + (s.stats?.cache_read ?? 0),
                comment: s.comment ?? "",
            });
        }

        index.projects.push({
        slug: p.slug, name: p.name ?? p.slug, repo: p.repo, sessions,
        totals: {
            cost_usd: sessions.reduce((a, s) => a + s.price, 0),
            tokens: sessions.reduce((a, s) => a + s.tokens, 0),
        },
        });
    } catch (e) {
        console.error(`skipping ${p.repo}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

writeFileSync(join(siteRoot, "_data", "logs.json"), JSON.stringify(index, null, 2));
console.log(`synced ${index.projects.length} project(s)`);