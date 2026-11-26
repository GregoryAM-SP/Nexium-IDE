/** Past this the snippet stops being a question and becomes a file dump. */
const MAX_SELECTION_CHARS = 6000;

/** The questions the editor's right-click menu can ask about a selection. */
export type SelectionIntent = "explain" | "refactor" | "bugs" | "document";

/** The selection entries in the editor's right-click menu, in menu order. */
export const selectionIntents: { id: SelectionIntent; label: string }[] = [
  { id: "explain", label: "Explain this selection" },
  { id: "refactor", label: "Refactor this selection" },
  { id: "bugs", label: "Find bugs in this selection" },
  { id: "document", label: "Document this selection" },
];

export type SelectionPromptInput = {
  path: string;
  language: string;
  intent: SelectionIntent;
  text: string;
  startLine: number;
  endLine: number;
};

/** The question each intent asks, with the code fenced underneath it. */
function selectionQuestion(
  intent: SelectionIntent,
  path: string,
  lines: string,
): string {
  switch (intent) {
    case "refactor":
      return `Refactor this code from \`${path}\` (${lines}): keep its behaviour but make it simpler and clearer.`;
    case "bugs":
      return `Review this code from \`${path}\` (${lines}): point out bugs, edge cases and risky assumptions.`;
    case "document":
      return `Document this code from \`${path}\` (${lines}): explain what it does and why, and show the comments you would add.`;
    default:
      return `Explain this code from \`${path}\` (${lines}): what it does and how it works.`;
  }
}

/**
 * A prompt about a selection: the chosen lines travel in the message itself, so
 * the model answers about exactly what was highlighted even when the selection
 * is only part of the open file.
 */
export function selectionPrompt({
  path,
  language,
  intent,
  text,
  startLine,
  endLine,
}: SelectionPromptInput): string {
  const lines =
    startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const snippet = text.replace(/\s+$/, "");
  const body =
    snippet.length > MAX_SELECTION_CHARS
      ? `${snippet.slice(0, MAX_SELECTION_CHARS)}\n…`
      : snippet;

  return `${selectionQuestion(intent, path, lines)}\n\n\`\`\`${language}\n${body}\n\`\`\`\n`;
}

/**
 * The prompt for a file or folder picked from the explorer's menu. The path is
 * enough: the assistant reads files with its own tools.
 */
export function pathPrompt(
  path: string,
  kind: "file" | "folder" = "file",
): string {
  return kind === "folder"
    ? `Explain the \`${path}\` folder: what lives in it and how its parts fit together.`
    : `Explain \`${path}\`: what it does and how it fits into this project.`;
}
