import path from "node:path";
import { z } from "zod";

export const RuleSchema = z.object({
  match: z
    .object({
      tool: z.string().optional().describe('Regex matched against the full tool name, e.g. "Read|Glob|Grep" or "mcp__.*". Omit for any tool.'),
      input: z
        .record(z.string())
        .optional()
        .describe('Map of tool_input field -> regex, e.g. {"command": "^(git push|rm )"}. All must match.'),
      path_outside: z
        .array(z.string())
        .optional()
        .describe('Matches when a path field (file_path/path/notebook_path) resolves outside ALL these roots. "${cwd}" = session cwd.'),
    })
    .default({}),
  action: z.enum(["allow", "deny", "rewrite", "escalate"]),
  reason: z.string().optional().describe("For deny: shown to cbc's model as the tool error."),
  patch: z.record(z.any()).optional().describe("For rewrite: fields merged into tool_input before the call runs."),
});
export type Rule = z.infer<typeof RuleSchema>;

export const PolicySchema = z.object({
  rules: z.array(RuleSchema).default([]),
  default_action: z.enum(["allow", "deny", "escalate"]).default("escalate"),
  escalate_timeout_s: z.number().int().min(5).max(3600).default(300),
  on_timeout: z.enum(["allow", "deny"]).default("deny"),
});
export type Policy = z.infer<typeof PolicySchema>;

export const READ_ONLY_TOOLS = "Read|Glob|Grep|LS|LSP|NotebookRead|TaskGet|TaskList|TaskOutput|ToolSearch|ListMcpResources|ReadMcpResource|ViewImage";

export const DEFAULT_POLICY: Policy = {
  rules: [
    { match: { tool: READ_ONLY_TOOLS, path_outside: ["${cwd}"] }, action: "escalate" },
    { match: { tool: READ_ONLY_TOOLS }, action: "allow" },
    { match: { tool: "TaskCreate|TaskUpdate|TaskStop|EnterPlanMode|ExitPlanMode" }, action: "allow" },
  ],
  default_action: "escalate",
  escalate_timeout_s: 300,
  on_timeout: "deny",
};

export type GateVerdict =
  | { action: "allow"; rule: number | "default"; updatedInput?: Record<string, any> }
  | { action: "deny"; rule: number | "default"; reason: string }
  | { action: "escalate"; rule: number | "default"; updatedInput?: Record<string, any> };

const PATH_FIELDS = ["file_path", "path", "notebook_path"];

function fullMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, "s").test(value);
  } catch {
    return false;
  }
}

function searchMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "s").test(value);
  } catch {
    return false;
  }
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function ruleMatches(rule: Rule, tool: string, input: Record<string, any>, cwd: string): boolean {
  const m = rule.match ?? {};
  if (m.tool && !fullMatch(m.tool, tool)) return false;
  if (m.input) {
    for (const [field, pattern] of Object.entries(m.input)) {
      const v = input?.[field];
      if (v === undefined) return false;
      if (!searchMatch(pattern, typeof v === "string" ? v : JSON.stringify(v))) return false;
    }
  }
  if (m.path_outside) {
    const roots = m.path_outside.map((r) => (r === "${cwd}" ? cwd : r.replaceAll("${cwd}", cwd)));
    const paths = PATH_FIELDS.map((f) => input?.[f]).filter((v): v is string => typeof v === "string" && v.length > 0);
    if (paths.length === 0) return false;
    const outside = paths.some((p) => !roots.some((r) => isInside(r, path.isAbsolute(p) ? p : path.join(cwd, p))));
    if (!outside) return false;
  }
  return true;
}

/**
 * Evaluate the policy. Rewrite rules patch the input and keep evaluating, so
 * a rewritten call is still subject to later deny/escalate rules.
 */
export function evaluate(policy: Policy, tool: string, input: Record<string, any>, cwd: string): GateVerdict {
  let current = input;
  let rewritten = false;
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if (!ruleMatches(rule, tool, current, cwd)) continue;
    switch (rule.action) {
      case "rewrite":
        current = { ...current, ...(rule.patch ?? {}) };
        rewritten = true;
        continue;
      case "allow":
        return { action: "allow", rule: i, ...(rewritten ? { updatedInput: current } : {}) };
      case "deny":
        return { action: "deny", rule: i, reason: rule.reason ?? `denied by supervisor policy (rule ${i})` };
      case "escalate":
        return { action: "escalate", rule: i, ...(rewritten ? { updatedInput: current } : {}) };
    }
  }
  const d = policy.default_action;
  if (d === "deny") return { action: "deny", rule: "default", reason: "denied by supervisor default policy" };
  return { action: d, rule: "default", ...(rewritten ? { updatedInput: current } : {}) };
}
