/**
 * Minimal agent loop.
 *
 *   export ANTHROPIC_API_KEY=...
 *   bun index.ts "What does this project do?"
 *
 * call model -> if it asked for tools, run them -> append results -> repeat.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync } from "node:fs";

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5-5";
const MAX_STEPS = 10;

// 1. Tools: plain functions the model can ask us to run.
const tools: Record<string, (input: any) => string> = {
  list_dir: ({ path = "." }) => readdirSync(path).join("\n"),
  read_file: ({ path }) => readFileSync(path, "utf8").slice(0, 8_000),
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
];


const agent = ()=>{

}
