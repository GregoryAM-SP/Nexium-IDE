import { invoke, isTauri, toError } from "./tauriBridge";
import { readFile } from "./workspaceFs";

export type GitChange = {
  path: string;
  status: string;
  staged: boolean;
};

export type GitStatus = {
  isRepo: boolean;
  branch: string;
  changes: GitChange[];
  message: string | null;
};

export type GitFileDiff = {
  /** The committed side, empty for a new file or a repository without commits. */
  original: string;
  /** HEAD against the index for a staged change, against the file for the rest. */
  modified: string;
};

export type GitIdentity = {
  name: string;
  email: string;
  configured: boolean;
};

let demoIdentity: GitIdentity = { name: "", email: "", configured: false };

/** Browser builds have no repository, so the panel gets a small in-memory one. */
let demo: GitStatus = {
  isRepo: true,
  branch: "main",
  changes: [
    { path: "src/App.tsx", status: "M", staged: true },
    { path: "src/components/SourceControlPanel.tsx", status: "A", staged: false },
    { path: "src/lib/git.ts", status: "U", staged: false },
    { path: "README.md", status: "M", staged: false },
  ],
  message: null,
};

function demoStatus(): GitStatus {
  return { ...demo, changes: demo.changes.map((change) => ({ ...change })) };
}

async function call(
  command: string,
  args?: Record<string, unknown>,
): Promise<GitStatus> {
  if (!isTauri()) {
    return demoStatus();
  }

  try {
    return await invoke<GitStatus>(command, args);
  } catch (cause) {
    throw toError(cause, "Git could not be read.");
  }
}

export function readGitStatus(): Promise<GitStatus> {
  return call("git_status");
}

export async function readGitFileDiff(
  path: string,
  staged: boolean,
): Promise<GitFileDiff> {
  if (!isTauri()) {
    const modified = await readFile(path).catch(() => "");
    const lines = modified.split("\n");

    // The browser demo has no repository, so the committed side is the file
    // without its last few lines: still a real diff, with real additions.
    return {
      original: lines.slice(0, Math.max(0, lines.length - 4)).join("\n"),
      modified,
    };
  }

  try {
    return await invoke<GitFileDiff>("git_file_diff", { path, staged });
  } catch (cause) {
    throw toError(cause, "That change could not be read.");
  }
}

export async function readGitIdentity(): Promise<GitIdentity> {
  if (!isTauri()) {
    return { ...demoIdentity };
  }

  try {
    return await invoke<GitIdentity>("git_identity");
  } catch (cause) {
    throw toError(cause, "Could not read the git identity.");
  }
}

export async function saveGitIdentity(
  name: string,
  email: string,
): Promise<GitIdentity> {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();

  if (!trimmedName) {
    throw new Error("Enter the name commits should use.");
  }

  if (!trimmedEmail.includes("@")) {
    throw new Error("Enter a valid email address.");
  }

  if (!isTauri()) {
    demoIdentity = {
      name: trimmedName,
      email: trimmedEmail,
      configured: true,
    };

    return { ...demoIdentity };
  }

  try {
    return await invoke<GitIdentity>("git_set_identity", {
      name: trimmedName,
      email: trimmedEmail,
    });
  } catch (cause) {
    throw toError(cause, "Could not save the git identity.");
  }
}

export async function stagePath(path: string): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_stage", { path });
  }

  demo = {
    ...demo,
    changes: demo.changes.map((change) =>
      change.path === path ? { ...change, staged: true } : change,
    ),
  };

  return demoStatus();
}

export async function unstagePath(path: string): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_unstage", { path });
  }

  demo = {
    ...demo,
    changes: demo.changes.map((change) =>
      change.path === path ? { ...change, staged: false } : change,
    ),
  };

  return demoStatus();
}

export async function stageAll(): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_stage_all");
  }

  demo = {
    ...demo,
    changes: demo.changes.map((change) => ({ ...change, staged: true })),
  };

  return demoStatus();
}

export async function unstageAll(): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_unstage_all");
  }

  demo = {
    ...demo,
    changes: demo.changes.map((change) => ({ ...change, staged: false })),
  };

  return demoStatus();
}

/**
 * Commits made from Nexium Studio credit it as a co-author, so GitHub shows
 * "Nexium" next to the author. The address is on the reserved `.invalid`
 * domain: it can never belong to a GitHub account, so the credit is the name
 * only and can never be attributed to a stranger's profile.
 */
export const NEXIUM_CO_AUTHOR = "Nexium <noreply@nexium-studio.invalid>";
const CREDIT_KEY = "nexium.git.creditNexium";

/** On unless the user turned it off in Settings → Source control. */
export function creditsNexium(): boolean {
  try {
    return localStorage.getItem(CREDIT_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setCreditsNexium(on: boolean): void {
  try {
    localStorage.setItem(CREDIT_KEY, String(on));
  } catch {
    // Without storage the default (on) simply applies.
  }
}

const TRAILER = /^[A-Za-z][A-Za-z0-9-]*:\s+\S/;

/**
 * Adds the `Co-authored-by: Nexium` trailer. GitHub only reads trailers in the
 * message's last paragraph, so it joins an existing trailer block (keeping any
 * co-authors already there) instead of starting a paragraph after it.
 */
export function withNexiumCredit(message: string): string {
  const text = message.trim();

  if (!text || /^co-authored-by:\s*nexium\b/im.test(text)) {
    return text;
  }

  const trailer = `Co-authored-by: ${NEXIUM_CO_AUTHOR}`;
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].split("\n");
  const endsWithTrailers =
    paragraphs.length > 1 && last.every((line) => TRAILER.test(line.trim()));

  return endsWithTrailers ? `${text}\n${trailer}` : `${text}\n\n${trailer}`;
}

function creditedMessage(message: string): string {
  return creditsNexium() ? withNexiumCredit(message) : message;
}

export async function commitChanges(message: string): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_commit", { message: creditedMessage(message) });
  }

  demo = {
    ...demo,
    changes: demo.changes.filter((change) => !change.staged),
  };

  return demoStatus();
}

export async function commitAndSync(message: string): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_commit_and_sync", { message: creditedMessage(message) });
  }

  // The browser demo has no remote, so syncing only commits there.
  return commitChanges(message);
}

export type GitTag = {
  name: string;
  /** Short hash of the tagged commit. */
  commit: string;
  annotated: boolean;
  /** The tag message (annotated) or the tagged commit's subject. */
  subject: string;
  /** ISO 8601. */
  date: string;
};

/** The browser demo keeps its tags in memory. */
let demoTags: GitTag[] = [
  {
    name: "v0.1.0",
    commit: "8602459",
    annotated: true,
    subject: "First preview",
    date: "2026-11-20T09:00:00+00:00",
  },
];

async function callTags(
  command: string,
  args?: Record<string, unknown>,
): Promise<GitTag[]> {
  try {
    return await invoke<GitTag[]>(command, args);
  } catch (cause) {
    throw toError(cause, "The tag operation failed.");
  }
}

/** Newest first, at most 100. */
export async function readGitTags(): Promise<GitTag[]> {
  return isTauri() ? callTags("git_tags") : demoTags.map((tag) => ({ ...tag }));
}

/** Tags the current commit; a message makes it annotated. */
export async function createGitTag(
  name: string,
  message: string,
  push: boolean,
): Promise<GitTag[]> {
  if (isTauri()) {
    return callTags("git_create_tag", { name, message, push });
  }

  if (demoTags.some((tag) => tag.name === name.trim())) {
    throw new Error(`A tag named "${name.trim()}" already exists.`);
  }

  demoTags = [
    {
      name: name.trim(),
      commit: "a53ec27",
      annotated: message.trim().length > 0,
      subject: message.trim() || "Latest commit",
      date: new Date().toISOString(),
    },
    ...demoTags,
  ];

  return readGitTags();
}

export async function pushGitTag(name: string): Promise<GitTag[]> {
  if (isTauri()) {
    return callTags("git_push_tag", { name });
  }

  throw new Error("The browser demo has no remote to push to.");
}

/** Removes the tag from this repository only, never from the remote. */
export async function deleteGitTag(name: string): Promise<GitTag[]> {
  if (isTauri()) {
    return callTags("git_delete_tag", { name });
  }

  demoTags = demoTags.filter((tag) => tag.name !== name);
  return readGitTags();
}

/** Accepts v1.2.3 and 1.2.3, with an optional -pre.release part. */
const VERSION = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The next patch, minor and major version after the newest version tag
 * (keeping its "v" prefix), or v0.1.0 / v1.0.0 when there is none yet.
 */
export function nextVersions(
  tags: GitTag[],
): { label: string; name: string }[] {
  let best: [string, number, number, number] | null = null;

  for (const tag of tags) {
    const match = VERSION.exec(tag.name);

    if (!match) {
      continue;
    }

    const version: [string, number, number, number] = [
      match[1],
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
    ];

    if (
      !best ||
      version[1] > best[1] ||
      (version[1] === best[1] && version[2] > best[2]) ||
      (version[1] === best[1] && version[2] === best[2] && version[3] > best[3])
    ) {
      best = version;
    }
  }

  if (!best) {
    return [
      { label: "First release", name: "v1.0.0" },
      { label: "Preview", name: "v0.1.0" },
    ];
  }

  const [prefix, major, minor, patch] = best;

  return [
    { label: "Patch", name: `${prefix}${major}.${minor}.${patch + 1}` },
    { label: "Minor", name: `${prefix}${major}.${minor + 1}.0` },
    { label: "Major", name: `${prefix}${major + 1}.0.0` },
  ];
}
