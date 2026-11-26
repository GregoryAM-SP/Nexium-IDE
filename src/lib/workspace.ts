export type WorkspaceFile = {
  path: string;
  content: string;
};

export type FileNode = { kind: "file"; name: string; path: string };

export type FolderNode = {
  kind: "folder";
  name: string;
  path: string;
  children: ExplorerNode[];
};

export type ExplorerNode = FileNode | FolderNode;

/**
 * Monaco models must use consistent file URIs so the TypeScript worker can
 * resolve relative imports between the files of the workspace.
 */
export const modelUri = (path: string) => `file:///${path}`;

const appTsx = `import { useState } from "react";

import CodeEditor from "./components/CodeEditor";
import Explorer from "./components/Explorer";

export default function App() {
  const [activePath, setActivePath] = useState("src/App.tsx");

  return (
    <div className="flex h-screen bg-black text-white">
      <Explorer activePath={activePath} onSelect={setActivePath} />
      <CodeEditor path={activePath} />
    </div>
  );
}
`;

const codeEditorTsx = `import Editor from "@monaco-editor/react";

type CodeEditorProps = {
  path: string;
  language?: string;
  value?: string;
  onChange?: (value: string) => void;
};

export default function CodeEditor(props: CodeEditorProps) {
  return (
    <Editor
      path={props.path}
      language={props.language}
      theme="nexium-black"
      value={props.value}
      onChange={(next) => props.onChange?.(next ?? "")}
      options={{ minimap: { enabled: false }, fontSize: 13 }}
    />
  );
}
`;

const explorerTsx = `type ExplorerProps = {
  activePath: string;
  onSelect: (path: string) => void;
};

export default function Explorer(props: ExplorerProps) {
  return (
    <aside className="w-64 border-r border-white/10">
      <p className="text-[11px] uppercase tracking-[0.18em] text-white/50">
        Explorer
      </p>
      <button
        type="button"
        onClick={() => props.onSelect("src/App.tsx")}
        className="px-4 py-1.5 text-[13px] text-white/50 hover:text-white"
      >
        App.tsx
      </button>
    </aside>
  );
}
`;

const indexCss = `@import "tailwindcss";

html {
  color-scheme: dark;
  background-color: #000000;
}

body {
  margin: 0;
  background-color: #000000;
  color: #ffffff;
}
`;

const mainTsx = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" href="/icon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nexium Studio</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const packageJson = `{
  "name": "nexium-ide",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  }
}
`;

const tsconfigJson = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true
  },
  "include": ["src", "vite.config.ts"]
}
`;

const viteConfig = `import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
  },
});
`;

const readmeMd = `# Nexium Studio

A black, keyboard-first editor shell built with React, TypeScript,
Tailwind CSS and Monaco.

## Scripts

| Command | Description |
| --- | --- |
| \`bun run dev\` | Start the dev server |
| \`bun run build\` | Type-check and build |
| \`bun run preview\` | Serve the production build |

> Every language Monaco ships with is highlighted automatically.
`;

const gitignore = `# Dependencies
node_modules

# Build output
dist

# Logs
*.log
`;

export const files: WorkspaceFile[] = [
  { path: "src/App.tsx", content: appTsx },
  { path: "src/components/CodeEditor.tsx", content: codeEditorTsx },
  { path: "src/components/Explorer.tsx", content: explorerTsx },
  { path: "src/index.css", content: indexCss },
  { path: "src/main.tsx", content: mainTsx },
  { path: "index.html", content: indexHtml },
  { path: "package.json", content: packageJson },
  { path: "tsconfig.json", content: tsconfigJson },
  { path: "vite.config.ts", content: viteConfig },
  { path: "README.md", content: readmeMd },
  { path: ".gitignore", content: gitignore },
];

export const initialContents: Record<string, string> = Object.fromEntries(
  files.map((file) => [file.path, file.content]),
);

export const defaultFilePath = "src/App.tsx";

export const initialTree: FolderNode = {
  kind: "folder",
  name: "nexium-studio",
  path: "",
  children: [
    {
      kind: "folder",
      name: "public",
      path: "public",
      children: [
        {
          kind: "folder",
          name: "fonts",
          path: "public/fonts",
          children: [
            {
              kind: "file",
              name: "JetBrains-Mono-400.woff2",
              path: "public/fonts/JetBrains-Mono-400.woff2",
            },
          ],
        },
      ],
    },
    {
      kind: "folder",
      name: "src",
      path: "src",
      children: [
        {
          kind: "folder",
          name: "components",
          path: "src/components",
          children: [
            {
              kind: "file",
              name: "CodeEditor.tsx",
              path: "src/components/CodeEditor.tsx",
            },
            {
              kind: "file",
              name: "Explorer.tsx",
              path: "src/components/Explorer.tsx",
            },
          ],
        },
        { kind: "file", name: "App.tsx", path: "src/App.tsx" },
        { kind: "file", name: "index.css", path: "src/index.css" },
        { kind: "file", name: "main.tsx", path: "src/main.tsx" },
      ],
    },
    { kind: "file", name: ".gitignore", path: ".gitignore" },
    { kind: "file", name: "index.html", path: "index.html" },
    { kind: "file", name: "package.json", path: "package.json" },
    { kind: "file", name: "README.md", path: "README.md" },
    { kind: "file", name: "tsconfig.json", path: "tsconfig.json" },
    { kind: "file", name: "vite.config.ts", path: "vite.config.ts" },
  ],
};
