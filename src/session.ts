import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir, userInfo } from "node:os";

export interface ToolMeta {
    name: string;
    version: string;
    plugins: string[];
}

export interface ModelMeta {
    name: string;
    runtime: string;
}

export interface Stats {
    turns: number;
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
}

export type TranscriptEntry =
    | { role: "user"; text: string }
    | { role: "assistant"; text: string }
    | { role: "tool"; name: string; path?: string; diff?: string[]; content?: string }
    | { role: "summary"; text: string };

export interface SessionJson {
    version: 3;
    tool: ToolMeta;
    model: ModelMeta | null;
    price_usd: number;
    comment: string;
    description: string;
    stats: Stats;
    transcript: TranscriptEntry[];
}

export interface ContentPart {
    type: string;
    text?: string;
    thinking?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface AgentMessage {
    role: string;
    content?: string | ContentPart[];
    command?: string;
    exitCode?: number;
    output?: string;
    summary?: string;
    usage?: {
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            total?: number;
        };
    };
    timestamp?: number;
    [key: string]: unknown;
}

export interface SessionEntry {
    type: string;
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    customType?: string;
    data?: unknown;
    summary?: string;
    message?: AgentMessage;
    [key: string]: unknown;
}

export interface SessionHeader {
    type: "session";
    version?: number;
    id: string;
    timestamp: string;
    cwd: string;
}

export type FileEntry = SessionHeader | SessionEntry;

export interface Redactor {
    (input: string): string;
}

export interface Options {
    input: string;
    outDir: string;
    comment: string;
    redactUser: string;
}

export function fail(msg: string, code = 1): never {
    console.error(`pelmeshi: ${msg}`);
    process.exit(code);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function makeRedactor(token: string, cwd: string): Redactor {
    const home = process.env.HOME ?? homedir();
    const user = userInfo().username;
    const rules: Array<[RegExp, string]> = [];

    if (cwd) rules.push([new RegExp(escapeRegExp(cwd), "g"), "."]);
    if (home && cwd.startsWith(home)) {
        const rel = cwd.slice(home.length).replace(/^\/+/, "");
        if (rel) rules.push([new RegExp(escapeRegExp(rel), "g"), "."]);
    }
    if (home) rules.push([new RegExp(escapeRegExp(home), "g"), "~"]);
    if (user) rules.push([new RegExp(escapeRegExp(user), "gi"), token]);

    if (rules.length === 0) return (s) => s;

    return (input) => {
        let out = input;
        for (const [re, rep] of rules) out = out.replace(re, rep);
        return out;
    };
}

export function redactDeep<T>(value: T, redact: Redactor): T {
    if (typeof value === "string") return redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as unknown as T;
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, redact);
        return out as unknown as T;
    }
    return value;
}

export function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function suffix(comment: string): string {
    const slug = comment
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^A-Za-z0-9_-]/g, "")
        .slice(0, 64);
    return slug || randomUUID().split("-")[0];
}

function parseSession(content: string): FileEntry[] {
    const entries: FileEntry[] = [];
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            entries.push(JSON.parse(trimmed) as FileEntry);
        } catch {
            fail(`malformed session line: ${trimmed.slice(0, 80)}`);
        }
    }
    if (entries.length === 0) fail("empty session file");
    if (entries[0].type !== "session") fail("not a pi session file");
    return entries;
}

function activePath(entries: FileEntry[]): SessionEntry[] {
    const session = entries.slice(1) as SessionEntry[];
    if (session.length === 0) return [];
    const byId = new Map<string, SessionEntry>();
    for (const e of session) if (e.id) byId.set(e.id, e);

    const leaf = session[session.length - 1];
    const path: SessionEntry[] = [];
    let current: SessionEntry | undefined = leaf;
    const seen = new Set<string>();
    while (current && current.id && !seen.has(current.id)) {
        seen.add(current.id);
        path.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path;
}

function asArray(content: string | ContentPart[] | undefined): ContentPart[] {
    if (!content) return [];
    return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function renderEditDiff(path: string, args: Record<string, unknown>): string[] {
    const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
    const lines: string[] = [`--- ${path}`, `+++ ${path}`];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const oldText = String(edit.oldText ?? "");
        const newText = String(edit.newText ?? "");
        lines.push(`@@ edit ${i + 1} @@`);
        for (const l of oldText.split("\n")) lines.push(`-${l}`);
        for (const l of newText.split("\n")) lines.push(`+${l}`);
    }
    return lines;
}

function toolEntry(name: string, args: Record<string, unknown>): TranscriptEntry {
    if (name === "edit" && typeof args.path === "string") {
        return { role: "tool", name: "edit", path: args.path, diff: renderEditDiff(args.path, args) };
    }
    if (name === "write" && typeof args.path === "string") {
        return { role: "tool", name: "write", path: args.path, content: String(args.content ?? "") };
    }
    return { role: "tool", name };
}

interface StatsAcc {
    turns: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cost: number;
    hasCost: boolean;
}

function extractText(parts: ContentPart[]): string {
    return parts
        .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
        .filter((t) => t.length > 0)
        .join("\n");
}

function convertMessage(msg: AgentMessage, out: TranscriptEntry[], stats: StatsAcc): void {
    const role = msg.role;
    if (role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(asArray(msg.content));
        if (text) out.push({ role: "user", text });
        return;
    }
    if (role === "assistant") {
        if (msg.usage) {
            stats.turns += 1;
            stats.tokensIn += msg.usage.input;
            stats.cacheRead += msg.usage.cacheRead ?? 0;
            stats.tokensOut += msg.usage.output;
            const total = msg.usage.cost?.total;
            if (typeof total === "number") {
                stats.cost += total;
                stats.hasCost = true;
            }
        }
        const text = extractText(asArray(msg.content).filter((p) => p.type === "text"));
        if (text) out.push({ role: "assistant", text });
        for (const part of asArray(msg.content)) {
            if (part.type === "toolCall" && part.name) {
                out.push(toolEntry(part.name, (part.arguments as Record<string, unknown>) ?? {}));
            }
        }
        return;
    }
    if (role === "bashExecution") {
        out.push({ role: "tool", name: "bash" });
        return;
    }
}

function resolveModel(path: SessionEntry[]): ModelMeta | null {
    let model: ModelMeta | null = null;
    for (const e of path) {
        if (e.type === "model_change" && e.provider && e.modelId) {
            model = { name: e.modelId, runtime: e.provider };
        }
    }
    return model;
}

function resolvePlugins(path: SessionEntry[]): string[] {
    const plugins = new Set<string>();
    for (const e of path) {
        if (e.type === "custom" && e.customType) plugins.add(e.customType.split("-")[0]);
    }
    return [...plugins];
}

function piVersion(): string {
    const candidates = [
        join(import.meta.dirname ?? ".", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
        join(import.meta.dirname ?? ".", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    ];
    for (const p of candidates) {
        try {
            const pkg = JSON.parse(readFileSync(p, "utf8"));
            return String(pkg.version ?? "unknown");
        } catch {}
    }
    return "unknown";
}

interface OpenRouterModel {
    id: string;
    pricing?: {
        prompt?: string;
        completion?: string;
        input_cache_read?: string;
    };
}

async function fetchPrice(modelId: string, stats: StatsAcc): Promise<number> {
    try {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return 0;
        const data = (await res.json()) as { data?: OpenRouterModel[] };
        const models = data.data ?? [];
        const m = models.find((x) => x.id === modelId);
        if (!m?.pricing) return 0;

        const pIn = parseFloat(m.pricing.prompt ?? "0");
        const pOut = parseFloat(m.pricing.completion ?? "0");
        const pCache = parseFloat(m.pricing.input_cache_read ?? m.pricing.prompt ?? "0");
        const total =
            pIn * stats.tokensIn
            + pCache * stats.cacheRead
            + pOut * stats.tokensOut;
        return Math.round(total * 10000) / 10000;
    } catch {
        return 0;
    }
}

export async function build(input: string, comment: string, redactUser: string): Promise<SessionJson> {
    const entries = parseSession(readFileSync(input, "utf8"));
    const cwd = (entries[0] as SessionHeader).cwd ?? "";
    const path = activePath(entries);

    const transcript: TranscriptEntry[] = [];
    const stats: StatsAcc = { turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cost: 0, hasCost: false };
    for (const e of path) {
        if (e.type === "message" && e.message) {
            convertMessage(e.message, transcript, stats);
        } else if (e.type === "compaction" || e.type === "branch_summary") {
            if (e.summary) transcript.push({ role: "summary", text: e.summary });
        }
    }

    const redact = makeRedactor(redactUser, cwd);
    const redacted = redactDeep(transcript, redact);

    const model = resolveModel(path);
    // Prefer provider-reported per-request cost (ground truth, matches OpenRouter
    // billing incl. provider-specific rates). Fall back to list-price estimate
    // for sessions recorded before pi tracked cost.
    const price_usd = stats.hasCost
        ? Math.round(stats.cost * 10000) / 10000
        : model ? await fetchPrice(model.name, stats) : 0;

    return {
        version: 3,
        tool: { name: "pi", version: piVersion(), plugins: resolvePlugins(path) },
        model,
        price_usd,
        comment: redact(comment),
        description: "",
        stats: { turns: stats.turns, tokens_in: stats.tokensIn, tokens_out: stats.tokensOut, cache_read: stats.cacheRead },
        transcript: redacted,
    };
}

export async function exportSession(input: string, outDir: string, comment: string, redactUser: string): Promise<string> {
    const inputPath = resolve(input);
    if (!existsSync(inputPath)) fail(`input not found: ${inputPath}`, 2);

    const outDirAbs = resolve(outDir);
    mkdirSync(outDirAbs, { recursive: true });

    const json = await build(inputPath, comment, redactUser);
    const slug = comment.trim() ? suffix(comment) : randomUUID();
    const outFile = join(outDirAbs, `${stamp()}_${slug}.json`);
    writeFileSync(outFile, `${JSON.stringify(json, null, 2)}\n`);
    return outFile;
}
