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

export async function commitChanges(message: string): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_commit", { message });
  }

  demo = {
    ...demo,
    changes: demo.changes.filter((change) => !change.staged),
  };

  return demoStatus();
}

export async function commitAndSync(message: string): Promise<GitStatus> {
  if (isTauri()) {
    return call("git_commit_and_sync", { message });
  }

  // The browser demo has no remote, so syncing only commits there.
  return commitChanges(message);
}
