import { monaco } from "./monacoSetup";

/**
 * Monaco ships every language it knows about through `monaco-editor`'s basic
 * language contributions, but a model only gets highlighted when it is created
 * with the right language id. This resolves a file path to that id, so any file
 * type dropped into the workspace is highlighted without a hard-coded list.
 */
const pathOverrides: Record<string, string> = {
  // Monaco registers TypeScript/JavaScript, not the VS Code "react" variants.
  ".tsx": "typescript",
  ".jsx": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  // Types Monaco has no grammar for, mapped onto the closest one it has.
  ".toml": "toml",
  ".env": "ini",
  ".conf": "ini",
  ".properties": "ini",
  ".vue": "html",
  ".svelte": "html",
  ".astro": "html",
  ".mk": "shell",
};

/** Whole names that say more than their extension does. */
const fileNameOverrides: Record<string, string> = {
  "cargo.lock": "toml",
  "bun.lock": "json",
  "makefile": "shell",
  "gemfile": "ruby",
  "rakefile": "ruby",
  "procfile": "shell",
  ".gitignore": "shell",
  ".dockerignore": "shell",
  ".npmignore": "shell",
  ".eslintignore": "shell",
  ".prettierignore": "shell",
};

type LanguageLookup = {
  byExtension: Map<string, string>;
  byFileName: Map<string, string>;
};

let lookup: LanguageLookup | undefined;

function buildLookup(): LanguageLookup {
  const byExtension = new Map<string, string>();
  const byFileName = new Map<string, string>();

  for (const language of monaco.languages.getLanguages()) {
    for (const extension of language.extensions ?? []) {
      const key = extension.toLowerCase();
      if (!byExtension.has(key)) {
        byExtension.set(key, language.id);
      }
    }

    for (const fileName of language.filenames ?? []) {
      const key = fileName.toLowerCase();
      if (!byFileName.has(key)) {
        byFileName.set(key, language.id);
      }
    }
  }

  return { byExtension, byFileName };
}

const fallbackLanguage = "plaintext";

export function languageForPath(path: string): string {
  lookup ??= buildLookup();

  const fileName = path.split("/").pop() ?? path;
  const lowerFileName = fileName.toLowerCase();

  const byFileName =
    fileNameOverrides[lowerFileName] ?? lookup.byFileName.get(lowerFileName);
  if (byFileName) {
    return byFileName;
  }

  // `.env.local`, `.env.production`: the part after the last dot is not a
  // language, so the leading name is what counts.
  if (lowerFileName.startsWith(".env")) {
    return "ini";
  }

  // Try the longest extension first so `types.d.ts` resolves like `typescript`.
  let candidate = lowerFileName;
  while (candidate.includes(".")) {
    candidate = candidate.slice(candidate.indexOf(".") + 1);
    const extension = `.${candidate}`;
    const match = lookup.byExtension.get(extension) ?? pathOverrides[extension];
    if (match) {
      return match;
    }
  }

  return fallbackLanguage;
}
