import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
    fail, fetchPricing, makeRedactor, redactDeep, renderDiff, roundUsd,
    type ModelMeta, type SessionJson, type TranscriptEntry,
} from "./session.ts";

// Claude Code transcripts live at ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
// Every line is one entry; an assistant reply is split into one entry per content
// block, all sharing message.id and a copy of the same usage.

interface ClaudeUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
    };
}

interface ClaudeBlock {
    type: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
}

export interface ClaudeEntry {
    type: string;
    uuid?: string;
    parentUuid?: string | null;
    logicalParentUuid?: string | null;
    sessionId?: string;
    cwd?: string;
    version?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    isCompactSummary?: boolean;
    totalCostUSD?: number;
    message?: {
        id?: string;
        role?: string;
        model?: string;
        content?: string | ClaudeBlock[];
        usage?: ClaudeUsage;
    };
    [key: string]: unknown;
}

export function findClaudeSession(sessionId: string): string {
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    if (existsSync(projects)) {
        for (const dir of readdirSync(projects)) {
            const p = join(projects, dir, `${sessionId}.jsonl`);
            if (existsSync(p)) return p;
        }
    }
    return fail(`no Claude Code transcript for session ${sessionId} under ${projects}`, 2);
}

function activePath(entries: ClaudeEntry[]): ClaudeEntry[] {
    const chain = entries.filter((e) => e.uuid && !e.isSidechain);
    const byId = new Map<string, ClaudeEntry>();
    for (const e of chain) byId.set(e.uuid!, e);

    const path: ClaudeEntry[] = [];
    const seen = new Set<string>();
    let current: ClaudeEntry | undefined = chain[chain.length - 1];
    while (current?.uuid && !seen.has(current.uuid)) {
        seen.add(current.uuid);
        path.unshift(current);
        // compaction starts a fresh chain; logicalParentUuid links it to the old one
        const parent: string | null | undefined = current.parentUuid ?? current.logicalParentUuid;
        current = parent ? byId.get(parent) : undefined;
    }
    return path;
}

const SKIPPED_TAGS = /^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification)>/;

function userText(content: string | ClaudeBlock[] | undefined): TranscriptEntry | null {
    const raw = typeof content === "string"
        ? content
        : (content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
    const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (!text || SKIPPED_TAGS.test(text)) return null;

    if (text.startsWith("<bash-input>")) return { role: "tool", name: "bash" };
    const cmd = text.match(/<command-name>\/?([^<]*)<\/command-name>/);
    if (cmd) {
        const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim();
        return { role: "user", text: `/${cmd[1]}${args ? ` ${args}` : ""}` };
    }
    return { role: "user", text };
}

function toolEntry(block: ClaudeBlock, cwd: string): TranscriptEntry {
    const name = block.name ?? "tool";
    const input = block.input ?? {};
    const rawPath = typeof input.file_path === "string" ? input.file_path : undefined;
    const path = rawPath && cwd && rawPath.startsWith(`${cwd}/`) ? rawPath.slice(cwd.length + 1) : rawPath;

    if (path && name === "Edit") {
        return { role: "tool", name: "edit", path, diff: renderDiff(path, [[String(input.old_string ?? ""), String(input.new_string ?? "")]]) };
    }
    if (path && name === "MultiEdit" && Array.isArray(input.edits)) {
        const pairs = (input.edits as Array<Record<string, unknown>>)
            .map((e): [string, string] => [String(e.old_string ?? ""), String(e.new_string ?? "")]);
        return { role: "tool", name: "edit", path, diff: renderDiff(path, pairs) };
    }
    if (path && name === "Write") {
        return { role: "tool", name: "write", path, content: String(input.content ?? "") };
    }
    return { role: "tool", name: name.startsWith("mcp__") ? name : name.toLowerCase() };
}

// Plan of the account Claude Code is logged in with now ("pro", "max", ...), null when
// it bills per token (API key, Bedrock, Vertex). It is the current login, not the one
// the session ran under, so pass --subscription when converting old transcripts.
function detectSubscription(): string | null {
    try {
        const out = execFileSync("claude", ["auth", "status", "--json"], { encoding: "utf8", timeout: 10_000 });
        const status = JSON.parse(out) as { authMethod?: string; subscriptionType?: string | null };
        return status.authMethod === "claude.ai" && status.subscriptionType ? status.subscriptionType : null;
    } catch (e) {
        console.error(`pelmeshi: couldn't read \`claude auth status\` (${e instanceof Error ? e.message : e}), pricing as pay-as-you-go; pass --subscription <plan|none> to set it`);
        return null;
    }
}

// "claude-opus-5-5" / "claude-haiku-4-5-20251001" -> "anthropic/claude-opus-5.5"
function openRouterId(model: string): string {
    return `anthropic/${model.replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

async function estimateCost(model: string, usage: ClaudeUsage): Promise<number> {
    const pricing = await fetchPricing(openRouterId(model));
    if (!pricing) return 0;
    const p = (v: string | undefined, fallback = "0") => parseFloat(v ?? fallback);
    const write = usage.cache_creation_input_tokens ?? 0;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    return p(pricing.prompt) * (usage.input_tokens ?? 0)
        + p(pricing.completion) * (usage.output_tokens ?? 0)
        + p(pricing.input_cache_read, pricing.prompt) * (usage.cache_read_input_tokens ?? 0)
        + p(pricing.input_cache_write, pricing.prompt) * (write - write1h)
        + p(pricing.input_cache_write_1h ?? pricing.input_cache_write, pricing.prompt) * write1h;
}

export async function buildClaude(entries: ClaudeEntry[], comment: string, redactUser: string, subscription?: string | null): Promise<SessionJson> {
    subscription = subscription === undefined ? detectSubscription() : subscription;
    const cwd = entries.find((e) => e.cwd)?.cwd ?? "";
    const path = activePath(entries);

    const transcript: TranscriptEntry[] = [];
    // one API response per message.id; later lines of the same id carry the same usage
    const responses = new Map<string, { model: string; usage: ClaudeUsage }>();
    for (const e of path) {
        const msg = e.message;
        if (!msg) continue;
        if (e.type === "user") {
            if (e.isCompactSummary && typeof msg.content === "string") {
                transcript.push({ role: "summary", text: msg.content });
            } else if (!e.isMeta) {
                const entry = userText(msg.content);
                if (entry) transcript.push(entry);
            }
        } else if (e.type === "assistant") {
            if (msg.id && msg.usage && msg.model && msg.model !== "<synthetic>") {
                responses.set(msg.id, { model: msg.model, usage: msg.usage });
            }
            for (const block of Array.isArray(msg.content) ? msg.content : []) {
                if (block.type === "text" && block.text) transcript.push({ role: "assistant", text: block.text });
                else if (block.type === "tool_use") transcript.push(toolEntry(block, cwd));
            }
        }
    }

    const stats = { turns: responses.size, tokens_in: 0, tokens_out: 0, cache_read: 0 };
    const modelCounts = new Map<string, number>();
    for (const { model, usage } of responses.values()) {
        stats.tokens_in += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        stats.tokens_out += usage.output_tokens ?? 0;
        stats.cache_read += usage.cache_read_input_tokens ?? 0;
        modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }
    const mainModel = [...modelCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const model: ModelMeta | null = mainModel ? { name: mainModel, runtime: "anthropic" } : null;

    // a subscription is paid for either way, so the session itself cost nothing
    const price = subscription ? 0 : await payAsYouGoCost(entries, responses);

    const redact = makeRedactor(redactUser, cwd);
    return {
        version: 4,
        tool: { name: "claude-code", version: entries.findLast((e) => e.version)?.version ?? "unknown", plugins: [] },
        model,
        price_usd: roundUsd(price),
        subscription,
        comment: redact(comment),
        description: "",
        stats,
        transcript: redactDeep(transcript, redact),
    };
}

// cost-state is Claude Code's own running total (incl. background calls), but it is
// only written now and then; estimate whatever was answered after the last one.
async function payAsYouGoCost(entries: ClaudeEntry[], responses: Map<string, { model: string; usage: ClaudeUsage }>): Promise<number> {
    let lastCost = -1;
    entries.forEach((e, i) => { if (e.type === "cost-state") lastCost = i; });
    let price = lastCost >= 0 ? entries[lastCost].totalCostUSD ?? 0 : 0;
    const counted = new Set<string>();
    for (const e of entries.slice(0, lastCost + 1)) if (e.message?.id) counted.add(e.message.id);
    for (const [id, { model, usage }] of responses) {
        if (!counted.has(id)) price += await estimateCost(model, usage);
    }
    return price;
}
