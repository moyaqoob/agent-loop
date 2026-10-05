#!/usr/bin/env -S npx tsx
/**
 * A coding-agent loop, written by hand. No framework.
 *
 *   npm install
 *   export ANTHROPIC_API_KEY=...
 *   npx tsx agent.ts --repo ~/code/some-repo "Where is authentication handled?"
 *
 * The whole idea:
 *   call model -> if it asked for tools, run them -> append results -> repeat.
 * Everything else is guard rails around that loop.
 */
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5-5";
// USD per million tokens. Fill from the pricing page; left at 0 so we never lie about cost.
const PRICE_IN = Number(process.env.PRICE_IN_PER_MTOK ?? 0);
const PRICE_OUT = Number(process.env.PRICE_OUT_PER_MTOK ?? 0);

const MAX_TOOL_OUTPUT = 8_000; // chars. Tool output is re-sent as input on EVERY later step.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "target", ".next",
]);

const SYSTEM = `You are a code-exploration agent working inside one repository.
Answer questions about the codebase by investigating it with your tools.

Rules:
- Search before you read. Read narrow line ranges, not whole files, when you can.
- Ground every claim in something you actually saw. Cite file:line.
- If you could not find something, say so. Do not guess from naming conventions.
- When you have enough evidence, stop calling tools and answer concisely.`;

// --------------------------------------------------------------------------- //
// Tools
// --------------------------------------------------------------------------- //
type Args = Record<string, unknown>;
type ToolFn = (root: string, args: Args) => string;

const truncate = (s: string, limit = MAX_TOOL_OUTPUT): string =>
  s.length <= limit
    ? s
    : s.slice(0, limit) + `\n...[truncated ${s.length - limit} chars; narrow your request]`;

// Tiny arg readers. The model's JSON is untrusted input: validate at the boundary.
function str(a: Args, k: string, dflt?: string): string {
  const v = a[k];
  if (typeof v === "string") return v;
  if (v === undefined && dflt !== undefined) return dflt;
  throw new Error(`argument '${k}' must be a string`);
}
function num(a: Args, k: string, dflt: number): number {
  const v = a[k];
  if (v === undefined) return dflt;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new Error(`argument '${k}' must be a number`);
}

/** Resolve rel inside root. realpath defeats ../ and symlink escapes. */
function safePath(root: string, rel: string): string {
  const real = realpathSync(path.resolve(root, rel));
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`path escapes repository root: ${rel}`);
  }
  return real;
}

const listDir: ToolFn = (root, a) => {
  const p = safePath(root, str(a, "path", "."));
  if (!statSync(p).isDirectory()) throw new Error("not a directory");
  const entries = readdirSync(p, { withFileTypes: true })
    .filter((e) => !SKIP_DIRS.has(e.name))
    .sort((x, y) => Number(x.isFile()) - Number(y.isFile()) || x.name.localeCompare(y.name))
    .map((e) => e.name + (e.isDirectory() ? "/" : ""));
  return entries.join("\n") || "(empty)";
};

const readFile: ToolFn = (root, a) => {
  const p = safePath(root, str(a, "path"));
  if (!statSync(p).isFile()) throw new Error("not a file");
  const lines = readFileSync(p, "utf8").split("\n");
  const start = Math.max(1, num(a, "start_line", 1));
  const end = Math.min(lines.length, num(a, "end_line", 300));
  const body: string[] = [];
  for (let i = start; i <= end; i++) body.push(`${String(i).padStart(5)}  ${lines[i - 1]}`);
  return truncate(body.join("\n")) + `\n[showing ${start}-${end} of ${lines.length} lines]`;
};

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const searchText: ToolFn = (root, a) => {
  const rx = new RegExp(str(a, "pattern"), "i");
  const base = safePath(root, str(a, "path", "."));
  const globRx = a.glob === undefined ? null : globToRegExp(str(a, "glob"));
  const max = num(a, "max_results", 40);
  const files = statSync(base).isFile() ? [base] : walk(base);
  const hits: string[] = [];
  for (const f of files) {
    if (globRx && !globRx.test(path.basename(f))) continue;
    let text: string;
    try {
      const buf = readFileSync(f);
      if (buf.subarray(0, 1024).includes(0)) continue; // binary
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      if (rx.test(line)) {
        hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= max) {
          hits.push(`[stopped at ${max} results; refine the pattern or path]`);
          return hits.join("\n");
        }
      }
    }
  }
  return hits.join("\n") || "no matches";
};

const runPython: ToolFn = (root, a) => {
  // WARNING: NOT a sandbox. Runs with your user's permissions.
  const code = str(a, "code");
  const timeout = Math.min(num(a, "timeout", 20), 60) * 1000;
  const r = spawnSync("python3", ["-c", code], {
    cwd: root, encoding: "utf8", timeout, maxBuffer: 1 << 20,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return `timed out after ${timeout / 1000}s`;
  }
  if (r.error) throw r.error;
  return truncate(`exit=${r.status}\n--stdout--\n${r.stdout}\n--stderr--\n${r.stderr}`);
};

const TOOLS: Record<string, ToolFn> = {
  list_dir: listDir, read_file: readFile, search_text: searchText, run_python: runPython,
};

const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: "list_dir",
    description: "List entries in a directory (relative to repo root). Directories end with '/'.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "read_file",
    description:
      "Read a file with line numbers. Defaults to lines 1-300; pass start_line/end_line for more.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_text",
    description:
      "Case-insensitive regex search across files. Returns file:line: text. " +
      "Use `glob` like '*.ts' to restrict by file name.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        max_results: { type: "integer" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_python",
    description:
      "Run a short Python snippet with the repo root as cwd. Use for counting, parsing, " +
      "or checking behavior. Print what you want to see.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string" }, timeout: { type: "integer" } },
      required: ["code"],
    },
  },
];

/** Errors go BACK TO THE MODEL as data. They never crash the loop. */
function executeTool(root: string, name: string, input: unknown): { output: string; isError: boolean } {
  const fn = TOOLS[name];
  if (!fn) return { output: `unknown tool: ${name}`, isError: true };
  try {
    return { output: fn(root, (input ?? {}) as Args), isError: false };
  } catch (e) {
    return { output: `${(e as Error).name}: ${(e as Error).message}`, isError: true };
  }
}

// --------------------------------------------------------------------------- //
// The loop
// --------------------------------------------------------------------------- //
const dollars = (tin: number, tout: number) => (tin / 1e6) * PRICE_IN + (tout / 1e6) * PRICE_OUT;

interface Limits { maxSteps: number; tokenBudget: number; logPath: string }

async function runAgent(task: string, root: string, lim: Limits): Promise<string> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  let tin = 0;
  let tout = 0;
  const log = (event: Record<string, unknown>) =>
    appendFileSync(lim.logPath, JSON.stringify({ t: Date.now() / 1000, ...event }) + "\n");

  log({ event: "start", task, model: MODEL, root, ...lim });

  const call = async (toolChoice?: Anthropic.ToolChoice) => {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      tools: TOOL_SCHEMAS, // must stay defined even when tool_choice is "none": history contains tool_use
      messages,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    });
    tin += resp.usage.input_tokens;
    tout += resp.usage.output_tokens;
    return resp;
  };
  const textOf = (r: Anthropic.Message) =>
    r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();

  for (let step = 1; step <= lim.maxSteps; step++) {
    const resp = await call();
    messages.push({ role: "assistant", content: resp.content });

    for (const b of resp.content) {
      if (b.type === "text" && b.text.trim()) {
        console.log(`\n[${step}] think: ${b.text.trim()}`);
        log({ event: "text", step, text: b.text });
      }
    }

    if (resp.stop_reason !== "tool_use") {
      log({ event: "done", step, tokens_in: tin, tokens_out: tout, stop_reason: resp.stop_reason });
      console.log(`\n--- ${step} steps | ${tin} in / ${tout} out tokens | $${dollars(tin, tout).toFixed(4)} ---`);
      return textOf(resp);
    }

    const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const t0 = Date.now();
      const { output, isError } = executeTool(root, b.name, b.input);
      const ms = Date.now() - t0;
      console.log(
        `[${step}] tool: ${b.name}(${JSON.stringify(b.input).slice(0, 140)}) -> ` +
        `${isError ? "ERROR " : ""}${output.length} chars, ${ms}ms`,
      );
      log({ event: "tool", step, name: b.name, input: b.input, is_error: isError, output, ms });
      results.push({ type: "tool_result", tool_use_id: b.id, content: output, is_error: isError });
    }
    console.log(`[${step}] running total: ${tin} in / ${tout} out | $${dollars(tin, tout).toFixed(4)}`);

    if (tin + tout > lim.tokenBudget) {
      console.log(`\n!! token budget exceeded (${tin + tout} > ${lim.tokenBudget}); forcing an answer`);
      // The text block rides in the SAME user message as the tool_results, so roles keep alternating.
      results.push({
        type: "text",
        text: "Budget exhausted. Answer now using only what you have seen. " +
          "Say clearly what you are unsure about or did not get to check.",
      });
      messages.push({ role: "user", content: results });
      log({ event: "budget_stop", step, tokens_in: tin, tokens_out: tout });
      return textOf(await call({ type: "none" }));
    }
    messages.push({ role: "user", content: results });
  }

  // Step limit: don't just die. Make the model say what it learned.
  console.log(`\n!! step limit (${lim.maxSteps}) reached; forcing an answer`);
  messages.push({
    role: "user",
    content: "Step limit reached. Answer now using only what you have seen, " +
      "and say what you did not get to verify.",
  });
  log({ event: "step_limit", tokens_in: tin, tokens_out: tout });
  return textOf(await call({ type: "none" }));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string", default: "." },
      "max-steps": { type: "string", default: "15" },
      "token-budget": { type: "string", default: "150000" },
      log: { type: "string", default: "agent_log.jsonl" },
    },
  });
  const question = positionals[0];
  if (!question) {
    console.error('usage: tsx agent.ts [--repo DIR] [--max-steps N] [--token-budget N] "question"');
    process.exit(2);
  }
  const root = realpathSync(path.resolve(values.repo!));
  const answer = await runAgent(question, root, {
    maxSteps: Number(values["max-steps"]),
    tokenBudget: Number(values["token-budget"]),
    logPath: values.log!,
  });
  console.log("\n=== ANSWER ===\n" + answer);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
