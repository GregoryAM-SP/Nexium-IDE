import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// NVIDIA's API sends no CORS headers, so the browser talks to this proxy and
// the proxy forwards to integrate.api.nvidia.com without the key leaving the
// request unchanged.
const nimProxy = {
  "/nim": {
    target: "https://integrate.api.nvidia.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/nim/, ""),
  },
};

/**
 * The editor's TypeScript worker only knows the files we hand it, so imports
 * like `lucide-react` looked unresolved. Its real declaration file is 2.6 MB of
 * 4240 icon declarations; this reduces it to just the export names.
 */
function lucideAmbientTypes(): Plugin {
  const id = "virtual:lucide-ambient";
  const resolvedId = `\0${id}`;

  return {
    name: "nexium-lucide-ambient",
    resolveId(source) {
      return source === id ? resolvedId : null;
    },
    async load(source) {
      if (source !== resolvedId) {
        return null;
      }

      const declaration = await readFile(
        resolve(
          process.cwd(),
          "node_modules/lucide-react/dist/lucide-react.d.ts",
        ),
        "utf8",
      );

      const names = [
        ...new Set(
          [...declaration.matchAll(/^declare const ([A-Za-z0-9_$]+):/gm)].map(
            (match) => match[1],
          ),
        ),
      ];

      const ambient = `declare module "lucide-react" {
  import type { ComponentType, SVGProps } from "react";

  export type LucideProps = SVGProps<SVGSVGElement> & {
    size?: string | number;
    absoluteStrokeWidth?: boolean;
    strokeWidth?: string | number;
  };

  export type LucideIcon = ComponentType<LucideProps>;

${names.map((name) => `  export const ${name}: LucideIcon;`).join("\n")}
}`;

      return `export default ${JSON.stringify(ambient)};`;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), lucideAmbientTypes()],
  server: {
    host: "127.0.0.1",
    // tauri.conf.json points the window at this exact port, so Vite must fail
    // loudly instead of drifting to 5174 when something already uses it.
    port: 5173,
    strictPort: true,
    proxy: nimProxy,
    // The desktop window edits this project as often as any other, and a hot
    // reload would throw away the open folder, the buffers and the chat every
    // time a source file is saved. The shell therefore runs Vite without HMR
    // (`npm run dev:desktop`); the browser keeps it for everyday UI work.
    hmr: mode === "desktop" ? false : undefined,
  },
  preview: {
    proxy: nimProxy,
  },
}));
