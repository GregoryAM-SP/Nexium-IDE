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

/** Streamed text joins the block before it when that block is the same kind. */
export function appendDelta(
  blocks: MessageBlock[],
  delta: AgentDelta,
): MessageBlock[] {
  const type = delta.kind === "reasoning" ? "reasoning" : "text";
  const last = blocks[blocks.length - 1];

  if (last && last.type === type) {
    return [...blocks.slice(0, -1), { type, text: last.text + delta.text }];
  }

  return [...blocks, { type, text: delta.text }];
}

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

  if (hasText(blocks)) {
    return blocks;
  }

  // Some models put the whole answer in the reasoning channel; the reply
  // already promotes it to text, so drop the duplicate thinking block.
  const withoutEcho = blocks.filter(
    (block) =>
      !(block.type === "reasoning" && block.text.trim() === reply.text.trim()),
  );

  return [
    ...withoutEcho,
    ...(reply.reasoning &&
    reply.reasoning.trim() !== reply.text.trim() &&
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
