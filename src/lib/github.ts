/**
 * GitHub: the signed-in account and publishing a folder as a new repository.
 * The token lives in the OS credential store on the Rust side; the webview
 * never sees it. Without a saved token the GitHub CLI's login is used.
 */
import type { GitStatus } from "./git";
import { invoke, isTauri, toError } from "./tauriBridge";

export type GitHubAccount = {
  login: string;
  name: string | null;
  avatarUrl: string;
  /** "token" (saved in Nexium) or "cli" (the GitHub CLI's login). */
  source: "token" | "cli";
  /** The user, then the organisations they belong to. */
  owners: string[];
};

export type CreatedRepo = {
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  private: boolean;
};

export type PublishResult = {
  repo: CreatedRepo;
  pushed: boolean;
  pushError: string | null;
  status: GitStatus;
};

/** Where to create a token with the scopes publishing needs. */
export const TOKEN_PAGE =
  "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Nexium+Studio";

const DESKTOP_ONLY = "GitHub publishing needs the desktop app.";

export async function readGitHubAccount(): Promise<GitHubAccount | null> {
  if (!isTauri()) {
    return null;
  }

  try {
    return await invoke<GitHubAccount | null>("github_account");
  } catch (cause) {
    throw toError(cause, "GitHub could not be reached.");
  }
}

export async function signInToGitHub(token: string): Promise<GitHubAccount> {
  if (!isTauri()) {
    throw new Error(DESKTOP_ONLY);
  }

  try {
    return await invoke<GitHubAccount>("github_sign_in", { token });
  } catch (cause) {
    throw toError(cause, "The token could not be checked.");
  }
}

export async function signOutOfGitHub(): Promise<void> {
  if (isTauri()) {
    await invoke<void>("github_sign_out");
  }
}

export async function suggestRepoName(): Promise<string> {
  if (!isTauri()) {
    return "my-project";
  }

  return invoke<string>("github_suggest_name");
}

export async function publishToGitHub(options: {
  owner: string;
  name: string;
  description: string;
  private: boolean;
}): Promise<PublishResult> {
  if (!isTauri()) {
    throw new Error(DESKTOP_ONLY);
  }

  try {
    return await invoke<PublishResult>("github_publish", options);
  } catch (cause) {
    throw toError(cause, "The repository could not be created.");
  }
}

export async function openOnGitHub(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }

  await invoke<void>("github_open", { url });
}

/** GitHub's rule for repository names, checked as the user types. */
export function repoNameProblem(name: string): string | null {
  if (!name) return "Enter a repository name.";
  if (name.length > 100) return "At most 100 characters.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Use letters, digits, ".", "-" and "_" only.';
  return null;
}
