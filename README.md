# pelmeshi

Acronym for "**P**rompt & **E**xchange **L**anguage **M**odel **E**fficient **S**ession **H**istory **I**ndex" yyyyeeah.

Personal tool I built to truncate and log pi/claude agent sessions into `.llm` for a searchable catalogue

## Installation

### pi

```bash
pi install git:github.com/caryph/pelmeshi
pi      # open pi agent
/reload # reload extensions
```

### Claude Code

Type at the Claude Code prompt (needs `node` >= 22.6 on your `PATH`):

```bash
/plugin install pelmeshi --marketplace caryph/pelmeshi
```

Answer `y`, then pick a scope.

### Library/CLI
Alternatively, install as a CLI tool:

```bash
npm i -g github:caryph/pelmeshi
pelmeshi <path/to/session.jsonl> [-o <output_dir>] [--comment <text>] [--redact-user <name>]
pelmeshi --claude-session <session-id> [...] # fetches ~/.claude/projects/*/<id>.jsonl
```

## Usage

```bash
/pelmeshi            # quick export
/pelmeshi <comment>  # export with comment
```

## Format

`.llm/YYYY-MM-DD_HHMM_<slug>.json`, schema `version: 4`:

```jsonc
{
  "version": 4,
  "tool": {"name": "pi", "version": "1.x", "plugins": ["..."]},
  "model": {"name": "qwen/qwen3.8-27b", "runtime": "openrouter"},
  "price_usd": 0.01,
  "subscription": null,
  "comment": "automatically added",
  "description": "manually added",
  "stats": {"turns": 67, "tokens_in": 1000, "tokens_out": 2000, "cache_read": 10000},
  "transcript": [
    {
      "role": "user",
      "text": "is this a real conversation"
    },
    {
      "role": "tool",
      "name": "bash"
    },
    {
      "role": "assistant",
      "text": "No, we're in a manually written example by the author."
    },
    {
      "role": "user",
      "text": "oh okay"
    }
  ]
}
```
