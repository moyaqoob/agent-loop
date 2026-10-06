/**
 * Minimal agent loop.
 *
 *   ollama serve   (with qwen3.5:4b pulled)
 *   bun index.ts "What does this project do?"
 *
 * call model -> if it asked for tools, run them -> append results -> repeat.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Ollama speaks the Anthropic Messages API; the key is required by the SDK but ignored.
const client = new Anthropic({ baseURL: "http://localhost:11434", apiKey: "ollama" });
const MODEL =  "qwen3.5:4b";
const MAX_STEPS = 10;

// 1. Tools: plain functions the model can ask us to run.
const tools: Record<string, (input: any) => string> = {
  list_dir: ({ path = "." }) => readdirSync(path).join("\n"),
  read_file: ({ path }) => readFileSync(path, "utf8").slice(0, 8_000),
  search_text: ({ pattern, path = "." }) => {
    const rx = new RegExp(pattern, "i");
    const hits: string[] = [];
    for (const file of readdirSync(path, { recursive: true }) as string[]) {
      if (file.split(/[\\/]/).some((p) => p === "node_modules" || p === ".git")) continue;
      let text: string;
      try {
        text = readFileSync(join(path, file), "utf8");
      } catch {
        continue; // directories and unreadable files
      }
      text.split("\n").forEach((line, i) => {
        if (rx.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
    return hits.slice(0, 50).join("\n") || "no matches";
  },
};

// 2. Schemas: the only thing the model knows about the tools.
const toolSchemas: Anthropic.Tool[] = [
  {
    name: "list_dir",
    description: "List files in a directory.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "read_file",
    description: "Read a text file.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "search_text",
    description:
      "Case-insensitive regex search across all files under a directory. Returns file:line: text. " +
      "Use this to find where something is defined or used before reading files.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
];


const agent = async (task: string) => {
  const system = `You are a code-exploration agent working inside one repository.
Answer questions about the codebase by investigating it with your tools.
- Ground every claim in something you actually saw in a file.
- If you could not find something, say so. Do not guess.
- When you have enough evidence, stop calling tools and answer concisely.`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let step = 1; step <= 4; step++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system,
      tools: toolSchemas,
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });
    console.log("response",resp)
    if (resp.stop_reason !== "tool_use") {
      return resp.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use" ) continue;
      // console.log(`block name [${step}] ${block.name}(${JSON.stringify(block.input)})`);
      let output: string;
      try {
        output = tools[block.name]!(block.input);
      } catch (e) {
        output = `error: ${(e as Error).message}`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  return "Step limit reached.";
};

console.log(await agent(process.argv[2] ?? "What files are in this directory?"));
