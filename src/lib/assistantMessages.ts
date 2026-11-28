import type { AgentDelta, AgentReply, AgentStep, Objective } from "./llm";

/**
 * An assistant turn is a timeline: text, thinking and tool steps in the order
 * they happened, so "I'll check the config" sits above the read it led to and
 * the answer comes after the edits it describes.
 */
export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "step"; step: AgentStep };

export type AssistantMessage = {
  id: number;
  role: "user" | "assistant";
  /** The final answer (assistant) or the prompt (user). */
  text: string;
  error?: boolean;
  /** The whole turn in order; absent for user messages and plain errors. */
  blocks?: MessageBlock[];
  /** The run spent every tool step, so it can be continued. */
  outOfSteps?: boolean;
};

/** Where the current model turn starts: just after the last tool step. */
function segmentStart(blocks: MessageBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].type === "step") {
      return index + 1;
    }
  }

  return 0;
}

/**
 * Adds a streamed piece to the turn. Between two tool steps a turn keeps one
 * thinking block and one answer block: some models interleave the two as
 * they stream ("thinking, Hello, thinking, ! How can I help"), and every
 * piece joins the block of its kind instead of starting a new one, so the
 * answer reads as one and the thinking stays in one place. A whitespace-only
 * piece with no block of its kind yet joins the newest block.
 */
export function appendDelta(
  blocks: MessageBlock[],
  delta: AgentDelta,
): MessageBlock[] {
  const type = delta.kind === "reasoning" ? "reasoning" : "text";
  const from = segmentStart(blocks);
  let target = -1;

  for (let index = from; index < blocks.length; index += 1) {
    if (blocks[index].type === type) {
      target = index;
    }
  }

  if (target < 0 && delta.text.trim() === "" && blocks.length > from) {
    target = blocks.length - 1;
  }

  if (target < 0) {
    return [...blocks, { type, text: delta.text }];
  }

  const block = blocks[target];

  if (block.type === "step") {
    return [...blocks, { type, text: delta.text }];
  }

  const next = [...blocks];
  next[target] = { type: block.type, text: block.text + delta.text };
  return next;
}

/**
 * The same rule for a finished or saved turn: whitespace-only pieces go, and
 * between tool steps all thinking joins the first thinking block and all
 * answer text the first answer block. Messages saved before this rule
 * display joined too.
 */
const TOOL_NAMES =
  "read_file|write_file|edit_file|list_files|search_text|run_command|set_objectives|session_status|message_sessions";

/** Tool-call markup some models write as text; the backend runs those calls. */
const TOOL_MARKUP: RegExp[] = [
  /<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g,
  /<function_call>[\s\S]*?(?:<\/function_call>|$)/g,
  new RegExp(String.raw`<function=(?:${TOOL_NAMES})>[\s\S]*?(?:<\/function>|$)`, "g"),
  /<\|tool_calls_section_begin\|>[\s\S]*?(?:<\|tool_calls_section_end\|>|$)/g,
  /<\|tool_call_begin\|>[\s\S]*?(?:<\|tool_call_end\|>|$)/g,
  /<｜tool▁calls▁begin｜>[\s\S]*?(?:<｜tool▁calls▁end｜>|$)/g,
  /<｜tool▁call▁begin｜>[\s\S]*?(?:<｜tool▁call▁end｜>|$)/g,
  /\[TOOL_CALLS\][\s\S]*$/g,
  new RegExp(
    String.raw`${"`".repeat(3)}(?:json|tool_call)?\s*\{\s*"(?:name|tool)"\s*:\s*"(?:${TOOL_NAMES})"[\s\S]*?(?:${"`".repeat(3)}|$)`,
    "g",
  ),
];

/** The text with any tool-call markup taken out. */
export function hideToolMarkup(text: string): string {
  if (!/<tool_call>|<function|<\||<｜|\[TOOL_CALLS\]|```/.test(text)) {
    return text;
  }

  let result = text;
  for (const pattern of TOOL_MARKUP) {
    result = result.replace(pattern, "");
  }
  return result === text ? text : result.replace(/\n{3,}/g, "\n\n");
}

export function mergeBlocks(blocks: MessageBlock[]): MessageBlock[] {
  const merged: MessageBlock[] = [];
  let segment: { reasoning?: number; text?: number } = {};

  for (const block of blocks) {
    if (block.type === "step") {
      merged.push(block);
      segment = {};
      continue;
    }

    if (block.text.trim() === "") {
      continue;
    }

    const existing = segment[block.type];

    if (existing === undefined) {
      segment[block.type] = merged.length;
      merged.push(block);
    } else {
      const current = merged[existing] as { type: "text" | "reasoning"; text: string };
      merged[existing] = { type: block.type, text: current.text + block.text };
    }
  }

  // Calls written as text are shown as steps; their markup is not.
  return merged
    .map((block) =>
      block.type === "step" ? block : { ...block, text: hideToolMarkup(block.text) },
    )
    .filter((block) => block.type === "step" || block.text.trim() !== "");
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** A step event either updates the step it belongs to or starts a new one. */
export function upsertStep(
  blocks: MessageBlock[],
  step: AgentStep,
): MessageBlock[] {
  const index = blocks.findIndex(
    (block) => block.type === "step" && block.step.id === step.id,
  );

  if (index < 0) {
    return [...blocks, { type: "step", step }];
  }

  const next = [...blocks];
  next[index] = { type: "step", step };
  return next;
}

const hasText = (blocks: MessageBlock[]) =>
  blocks.some((block) => block.type === "text" && block.text.trim().length > 0);

/**
 * The finished turn. Streamed blocks are the truth when they carry the answer;
 * a model that could not stream only sends the reply, so it is added at the end.
 */
export function finishBlocks(
  streamed: MessageBlock[],
  reply: AgentReply,
): MessageBlock[] {
  let blocks = streamed;

  for (const step of reply.steps) {
    blocks = upsertStep(blocks, step);
  }

  blocks = mergeBlocks(blocks);

  if (hasText(blocks)) {
    return blocks;
  }

  // Some models put the whole answer in the reasoning channel; the reply
  // already promotes it to text, so drop the thinking that repeats it (in
  // whole or in pieces) and show it once, as the answer.
  const answer = squash(reply.text);
  const withoutEcho = blocks.filter(
    (block) =>
      !(block.type === "reasoning" && answer.includes(squash(block.text))),
  );

  return [
    ...withoutEcho,
    ...(reply.reasoning &&
    !answer.includes(squash(reply.reasoning)) &&
    !withoutEcho.some((block) => block.type === "reasoning")
      ? [{ type: "reasoning" as const, text: reply.reasoning }]
      : []),
    { type: "text", text: reply.text },
  ];
}

const VERBS: Record<string, string> = {
  list_files: "listed",
  read_file: "read",
  search_text: "searched",
  edit_file: "edited",
  write_file: "wrote",
  run_command: "ran",
  session_status: "checked",
  message_sessions: "messaged",
};

/**
 * Earlier turns go back to the model as plain text, so without this note it
 * forgets which files it already read or changed and starts over every turn.
 */
export function historyContent(message: AssistantMessage): string {
  const steps = (message.blocks ?? []).flatMap((block) =>
    block.type === "step" && block.step.tool ? [block.step] : [],
  );
  // The checklist goes back too, so "continue" picks up where it stopped.
  const checklist = objectivesOf(message.blocks ?? []);
  const objectives = checklist
    ? `[Objectives: ${checklist
        .map((objective) => `${objective.title} (${objective.status.replace("_", " ")})`)
        .join("; ")}]\n`
    : "";

  if (steps.length === 0) {
    return objectives ? `${objectives}\n${message.text}` : message.text;
  }

  const actions = steps.map((step) => {
    const verb = VERBS[step.tool ?? ""] ?? step.tool;
    const target = step.path ?? step.title;
    const outcome =
      step.kind === "rejected"
        ? " (the user rejected this change)"
        : step.status === "error"
          ? " (failed)"
          : "";

    return `${verb} ${target}${outcome}`;
  });

  return `${objectives}[Tools used in this turn: ${actions.join("; ")}]\n\n${message.text}`;
}

/** The turn's checklist, if the agent kept one. */
export function objectivesOf(blocks: MessageBlock[]): Objective[] | null {
  for (const block of blocks) {
    if (
      block.type === "step" &&
      block.step.kind === "objectives" &&
      block.step.objectives?.length
    ) {
      return block.step.objectives;
    }
  }

  return null;
}
