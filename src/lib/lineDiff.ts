/** One line of a unified diff. */
export type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

/** A run of changed lines with a little unchanged context around it. */
export type DiffHunk = {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type LineDiff = {
  hunks: DiffHunk[];
  added: number;
  removed: number;
};

const CONTEXT = 3;
/** Past this many cells the LCS table is too big; show the block as replaced. */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

/** Edit script for the changed middle, by longest common subsequence. */
function middleScript(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: "added" as const, text })),
    ];
  }

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const script: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      script.push({ kind: "context", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      script.push({ kind: "removed", text: a[i] });
      i += 1;
    } else {
      script.push({ kind: "added", text: b[j] });
      j += 1;
    }
  }

  while (i < a.length) {
    script.push({ kind: "removed", text: a[i++] });
  }

  while (j < b.length) {
    script.push({ kind: "added", text: b[j++] });
  }

  return script;
}

/**
 * A unified, line-based diff of two versions of a file, grouped into hunks with
 * three lines of context — the compact view a chat panel has room for.
 */
export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const script: DiffLine[] = [
    ...a.slice(0, head).map((text) => ({ kind: "context" as const, text })),
    ...middleScript(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text) => ({ kind: "context" as const, text })),
  ];

  let added = 0;
  let removed = 0;
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 1;
  let newLine = 1;
  let lastChange = -Infinity;

  script.forEach((line, index) => {
    if (line.kind !== "context") {
      if (!current || index - lastChange > CONTEXT * 2) {
        // Close the previous hunk with its trailing context.
        current?.lines.push(
          ...script.slice(lastChange + 1, lastChange + 1 + CONTEXT),
        );

        const start = Math.max(0, index - CONTEXT);
        const leading = script.slice(start, index);
        const contextBefore = leading.length;

        current = {
          oldStart: oldLine - contextBefore,
          newStart: newLine - contextBefore,
          lines: [...leading],
        };
        hunks.push(current);
      } else {
        current.lines.push(...script.slice(lastChange + 1, index));
      }

      current.lines.push(line);
      lastChange = index;

      if (line.kind === "added") {
        added += 1;
      } else {
        removed += 1;
      }
    }

    if (line.kind !== "added") {
      oldLine += 1;
    }

    if (line.kind !== "removed") {
      newLine += 1;
    }
  });

  if (current) {
    const hunk: DiffHunk = current;
    hunk.lines.push(...script.slice(lastChange + 1, lastChange + 1 + CONTEXT));
  }

  return { hunks, added, removed };
}
