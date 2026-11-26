import { readGitFileDiff } from "./git";
import type { GitChange } from "./git";
import { chat } from "./nim";

/**
 * Writes the commit message for the staged changes with the assistant's model.
 * The button in the source control panel is the only caller.
 */

/** A long change set is described by its first files; the rest still get listed. */
const MAX_DIFF_FILES = 10;
const MAX_SECTION_CHARS = 2600;
const MAX_PROMPT_CHARS = 9000;
const MAX_MESSAGE_CHARS = 2000;

const SYSTEM_PROMPT = [
  "You write git commit messages for a code editor's source control panel.",
  "Reply with the message only: no markdown, no code fences, no quotes, no explanation.",
  "Start with one imperative subject line under 72 characters and without a trailing period.",
  "Add a short body of plain lines only when the change needs explaining, after a blank line.",
].join(" ");

const STATUS_LABEL: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "untracked",
};

/**
 * The committed and working sides are whole files, so only the lines around the
 * difference are sent: common leading and trailing lines are dropped.
 */
function summarizeDiff(original: string, modified: string): string {
  const before = original.replace(/\r\n/g, "\n").split("\n");
  const after = modified.replace(/\r\n/g, "\n").split("\n");

  let start = 0;

  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;

  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    before[beforeEnd] === after[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const lines = [`@@ from line ${start + 1} @@`];

  for (const line of before.slice(start, beforeEnd + 1)) {
    lines.push(`-${line}`);
  }

  for (const line of after.slice(start, afterEnd + 1)) {
    lines.push(`+${line}`);
  }

  const text = lines.join("\n");

  return text.length > MAX_SECTION_CHARS
    ? `${text.slice(0, MAX_SECTION_CHARS)}\n… (truncated)`
    : text;
}

function buildPrompt(changes: GitChange[], sections: string[]): string {
  const listed = changes
    .map(
      (change) =>
        `${STATUS_LABEL[change.status] ?? change.status}: ${change.path}`,
    )
    .join("\n");

  const prompt = [
    "Changes staged for this commit:",
    listed,
    "",
    "Diff:",
    sections.join("\n\n"),
    "",
    "Write the commit message for this commit.",
  ].join("\n");

  return prompt.length > MAX_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n… (diff truncated)`
    : prompt;
}

/** Models sometimes wrap the message in a fence, a label or quotes. */
function cleanCommitMessage(reply: string): string {
  let text = reply.replace(/\r\n/g, "\n").trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);

  if (fenced) {
    text = fenced[1].trim();
  }

  text = text.replace(/^(?:commit message|message)\s*:\s*/i, "").trim();

  const first = text[0];
  const last = text[text.length - 1];

  if (
    text.length > 2 &&
    (first === '"' || first === "'") &&
    last === first
  ) {
    text = text.slice(1, -1).trim();
  }

  return text.slice(0, MAX_MESSAGE_CHARS).trim();
}

export async function generateCommitMessage(
  apiKey: string,
  model: string,
  changes: GitChange[],
): Promise<string> {
  if (!apiKey || !model) {
    throw new Error("Select a model in Settings to generate a commit message.");
  }

  const staged = changes.filter((change) => change.staged);

  if (staged.length === 0) {
    throw new Error("Stage the changes to describe first.");
  }

  const sections = await Promise.all(
    staged.slice(0, MAX_DIFF_FILES).map(async (change) => {
      const header = `--- ${change.path} (${STATUS_LABEL[change.status] ?? change.status}) ---`;

      try {
        const { original, modified } = await readGitFileDiff(change.path, true);

        return `${header}\n${summarizeDiff(original, modified)}`;
      } catch {
        // A deleted or binary file still tells the model what changed.
        return `${header}\n(content unavailable)`;
      }
    }),
  );

  const reply = await chat(apiKey, model, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildPrompt(staged, sections) },
  ]);

  const message = cleanCommitMessage(reply);

  if (!message) {
    throw new Error("The model returned an empty commit message.");
  }

  return message;
}
