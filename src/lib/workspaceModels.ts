import csstypeTypes from "../../node_modules/csstype/index.d.ts?raw";
import reactGlobalTypes from "../../node_modules/@types/react/global.d.ts?raw";
import reactJsxDevRuntimeTypes from "../../node_modules/@types/react/jsx-dev-runtime.d.ts?raw";
import reactJsxRuntimeTypes from "../../node_modules/@types/react/jsx-runtime.d.ts?raw";
import reactTypes from "../../node_modules/@types/react/index.d.ts?raw";
import tauriCoreTypes from "../../node_modules/@tauri-apps/api/core.d.ts?raw";
import tauriEventTypes from "../../node_modules/@tauri-apps/api/event.d.ts?raw";
import tauriDialogTypes from "../../node_modules/@tauri-apps/plugin-dialog/dist-js/index.d.ts?raw";
import monacoTypes from "../../node_modules/monaco-editor/monaco.d.ts?raw";
import lucideAmbient from "virtual:lucide-ambient";

import { languageForPath } from "./languages";
import { monaco } from "./monacoSetup";
import { files, modelUri } from "./workspace";

/**
 * Ambient declarations for packages whose typings are not shipped into the
 * editor's TypeScript worker. They keep the sample workspace free of
 * "cannot find module" noise without weakening the real project type-check,
 * which is still done by `tsc` during the build.
 */
const sandboxShims = `declare module "*.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "react-dom/client" {
  export function createRoot(container: Element): { render(node: unknown): void };
}

declare module "@monaco-editor/react" {
  import type { ComponentType } from "react";

  type EditorProps = {
    path?: string;
    language?: string;
    value?: string;
    defaultValue?: string;
    theme?: string;
    options?: Record<string, unknown>;
    loading?: unknown;
    onChange?: (value: string | undefined) => void;
  };

  const Editor: ComponentType<EditorProps>;
  export default Editor;
}

declare module "vite" {
  export function defineConfig<T>(config: T): T;
}

declare module "@vitejs/plugin-react" {
  const plugin: () => unknown;
  export default plugin;
}

declare module "@tailwindcss/vite" {
  const plugin: () => unknown;
  export default plugin;
}

declare module "monaco-editor" {
  // monaco.d.ts declares a global monaco namespace; this exposes it as a module.
  export = monaco;
}

// The TypeScript worker has no @types/node, so Node code opened from disk would
// report "Cannot find module 'node:path'" (TS 2307) even though the project
// builds. These declarations keep the editor honest about Node built-ins; they
// are deliberately loose, since the worker cannot see the real type package.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  pid: number;
  cwd(): string;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
  stdout: { write(chunk: string): void; isTTY?: boolean };
  stderr: { write(chunk: string): void; isTTY?: boolean };
};

declare const Buffer: {
  from(input: string | ArrayBufferLike | ArrayLike<number>, encoding?: string): any;
  alloc(size: number, fill?: number | string): any;
  isBuffer(value: unknown): boolean;
};

declare const __dirname: string;

declare const __filename: string;

declare function require(id: string): any;

declare module "node:path" {
  namespace path {
    const sep: string;
    const delimiter: string;
    function basename(p: string, suffix?: string): string;
    function dirname(p: string): string;
    function extname(p: string): string;
    function format(p: {
      root?: string;
      dir?: string;
      base?: string;
      ext?: string;
      name?: string;
    }): string;
    function isAbsolute(p: string): boolean;
    function join(...parts: string[]): string;
    function normalize(p: string): string;
    function parse(p: string): {
      root: string;
      dir: string;
      base: string;
      ext: string;
      name: string;
    };
    function relative(from: string, to: string): string;
    function resolve(...parts: string[]): string;
    function toNamespacedPath(p: string): string;
  }
  export = path;
}

declare module "path" {
  import aliased = require("node:path");
  export = aliased;
}

declare module "node:fs" {
  namespace fs {
    function readFileSync(path: string | URL, options?: any): any;
    function writeFileSync(path: string | URL, data: any, options?: any): void;
    function appendFileSync(path: string | URL, data: any, options?: any): void;
    function existsSync(path: string | URL): boolean;
    function mkdirSync(path: string | URL, options?: any): any;
    function rmSync(path: string | URL, options?: any): void;
    function readdirSync(path: string | URL, options?: any): any;
    function statSync(path: string | URL, options?: any): any;
    function lstatSync(path: string | URL): any;
    function realpathSync(path: string | URL): string;
    function createReadStream(path: string | URL, options?: any): any;
    function createWriteStream(path: string | URL, options?: any): any;
    function watch(path: string, listener?: (...args: any[]) => void): any;
  }
  export = fs;
}

declare module "fs" {
  import aliased = require("node:fs");
  export = aliased;
}

declare module "node:fs/promises" {
  namespace fsp {
    function readFile(path: string | URL, options?: any): Promise<any>;
    function writeFile(path: string | URL, data: any, options?: any): Promise<void>;
    function appendFile(path: string | URL, data: any, options?: any): Promise<void>;
    function mkdir(path: string | URL, options?: any): Promise<any>;
    function rm(path: string | URL, options?: any): Promise<void>;
    function readdir(path: string | URL, options?: any): Promise<any>;
    function stat(path: string | URL, options?: any): Promise<any>;
    function access(path: string | URL, mode?: number): Promise<void>;
    function copyFile(src: string, dest: string, mode?: number): Promise<void>;
    function rename(from: string, to: string): Promise<void>;
    function realpath(path: string | URL): Promise<string>;
    function unlink(path: string | URL): Promise<void>;
  }
  export = fsp;
}

declare module "node:url" {
  namespace url {
    const URL: typeof globalThis.URL;
    const URLSearchParams: typeof globalThis.URLSearchParams;
    function fileURLToPath(url: string | URL): string;
    function pathToFileURL(path: string): URL;
    function format(url: any, options?: any): string;
  }
  export = url;
}

declare module "url" {
  import aliased = require("node:url");
  export = aliased;
}

declare module "node:os" {
  namespace os {
    const EOL: string;
    function platform(): string;
    function arch(): string;
    function homedir(): string;
    function tmpdir(): string;
    function hostname(): string;
    function cpus(): any[];
    function totalmem(): number;
    function freemem(): number;
    function type(): string;
    function release(): string;
  }
  export = os;
}

declare module "os" {
  import aliased = require("node:os");
  export = aliased;
}

declare module "node:util" {
  namespace util {
    function promisify(fn: (...args: any[]) => any): (...args: any[]) => Promise<any>;
    function inspect(value: unknown, options?: any): string;
    function format(template?: any, ...args: any[]): string;
    function inherits(ctor: any, superCtor: any): void;
    const types: any;
  }
  export = util;
}

declare module "util" {
  import aliased = require("node:util");
  export = aliased;
}

declare module "node:crypto" {
  namespace crypto {
    function randomUUID(): string;
    function randomBytes(size: number): any;
    function createHash(algorithm: string): {
      update(data: any, inputEncoding?: string): any;
      digest(encoding?: string): any;
    };
  }
  export = crypto;
}

declare module "crypto" {
  import aliased = require("node:crypto");
  export = aliased;
}

declare module "node:events" {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
    removeAllListeners(event?: string): this;
  }
  const events: { EventEmitter: typeof EventEmitter };
  export default events;
}

declare module "events" {
  import aliased from "node:events";
  export = aliased;
}

declare module "node:child_process" {
  namespace childProcess {
    function exec(command: string, callback?: (...args: any[]) => void): any;
    function execSync(command: string, options?: any): any;
    function spawn(command: string, args?: string[], options?: any): any;
    function spawnSync(command: string, args?: string[], options?: any): any;
    function execFile(file: string, args?: string[], options?: any, callback?: (...args: any[]) => void): any;
  }
  export = childProcess;
}

declare module "child_process" {
  import aliased = require("node:child_process");
  export = aliased;
}

declare module "node:stream" {
  class Readable {
    on(event: string, listener: (...args: any[]) => void): this;
    pipe<T>(destination: T): T;
  }
  class Writable {
    write(chunk: any, encoding?: string, callback?: () => void): boolean;
    end(chunk?: any): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  class Transform extends Readable {}
  class PassThrough extends Transform {}
  export { Readable, Writable, Transform, PassThrough };
}

declare module "node:buffer" {
  export { Buffer };
}

declare module "node:module" {
  namespace mod {
    function createRequire(filename: string | URL): (id: string) => any;
  }
  export = mod;
}

declare module "module" {
  import aliased = require("node:module");
  export = aliased;
}

declare module "node:http" {
  namespace http {
    function createServer(handler?: (...args: any[]) => void): any;
    function request(options: any, callback?: (...args: any[]) => void): any;
    function get(options: any, callback?: (...args: any[]) => void): any;
  }
  export = http;
}

declare module "node:https" {
  import aliased = require("node:http");
  export = aliased;
}

declare module "node:assert" {
  namespace assert {
    function ok(value: unknown, message?: string): void;
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function strictEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  export = assert;
}

declare module "node:assert/strict" {
  import aliased = require("node:assert");
  export = aliased;
}

declare module "node:process" {
  const proc: typeof process;
  export default proc;
}

declare module "node:readline" {
  export function createInterface(options: any): {
    on(event: string, listener: (...args: any[]) => void): any;
    close(): void;
  };
}

declare module "node:zlib" {
  namespace zlib {
    function gzipSync(data: any): any;
    function gunzipSync(data: any): any;
    function deflateSync(data: any): any;
    function inflateSync(data: any): any;
  }
  export = zlib;
}

declare module "node:worker_threads" {
  const isMainThread: boolean;
  const parentPort: any;
  class Worker {
    constructor(filename: string | URL, options?: any);
    on(event: string, listener: (...args: any[]) => void): this;
    postMessage(value: any): void;
    terminate(): Promise<number>;
  }
  export { isMainThread, parentPort, Worker };
}

declare module "node:tty" {
  export function isatty(fd: number): boolean;
}
`;

/**
 * Registers files read from disk as Monaco models. The TypeScript worker only
 * resolves a relative import when the target has a model, so opening one file
 * in a folder is not enough.
 */
export function registerWorkspaceSources(
  files: { path: string; contents: string }[],
): string[] {
  const registered: string[] = [];

  for (const file of files) {
    const uri = monaco.Uri.parse(modelUri(file.path));
    const language = languageForPath(file.path);
    const model = monaco.editor.getModel(uri);

    if (model) {
      monaco.editor.setModelLanguage(model, language);
    } else {
      monaco.editor.createModel(file.contents, language, uri);
    }

    registered.push(file.path);
  }

  return registered;

}

let initialized = false;

/**
 * Registers every workspace file as a Monaco model and teaches the TypeScript
 * worker about the project, so cross-file imports resolve instead of reporting
 * "Cannot find module" (TS 2792).
 */
export function initWorkspaceModels(loadSampleFiles = true): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const {
    JsxEmit,
    ModuleKind,
    ModuleResolutionKind,
    ScriptTarget,
    typescriptDefaults,
  } = monaco.typescript;

  // Without eager sync only models of open editors reach the worker, so
  // imports that point at files the user has not opened would not resolve.
  typescriptDefaults.setEagerModelSync(true);

  typescriptDefaults.setCompilerOptions({
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    jsx: JsxEmit.ReactJSX,
    lib: ["es2022", "dom", "dom.iterable"],
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    strict: true,
  });

  typescriptDefaults.addExtraLib(
    reactTypes,
    "file:///node_modules/@types/react/index.d.ts",
  );
  typescriptDefaults.addExtraLib(
    reactGlobalTypes,
    "file:///node_modules/@types/react/global.d.ts",
  );
  typescriptDefaults.addExtraLib(
    reactJsxRuntimeTypes,
    "file:///node_modules/@types/react/jsx-runtime.d.ts",
  );
  typescriptDefaults.addExtraLib(
    reactJsxDevRuntimeTypes,
    "file:///node_modules/@types/react/jsx-dev-runtime.d.ts",
  );
  typescriptDefaults.addExtraLib(
    csstypeTypes,
    "file:///node_modules/csstype/index.d.ts",
  );
  typescriptDefaults.addExtraLib(sandboxShims, "file:///types/sandbox-shims.d.ts");

  // Real declarations for the packages this project imports, so files opened
  // from disk do not report "Cannot find module" for them.
  typescriptDefaults.addExtraLib(
    lucideAmbient,
    "file:///node_modules/lucide-react/index.d.ts",
  );
  typescriptDefaults.addExtraLib(monacoTypes, "file:///types/monaco-editor.d.ts");
  typescriptDefaults.addExtraLib(
    tauriCoreTypes,
    "file:///node_modules/@tauri-apps/api/core.d.ts",
  );
  typescriptDefaults.addExtraLib(
    tauriEventTypes,
    "file:///node_modules/@tauri-apps/api/event.d.ts",
  );
  typescriptDefaults.addExtraLib(
    tauriDialogTypes,
    "file:///node_modules/@tauri-apps/plugin-dialog/index.d.ts",
  );

  if (!loadSampleFiles) {
    // A real folder is opened from disk: models are created as files are read.
    return;
  }

  for (const file of files) {
    const uri = monaco.Uri.parse(modelUri(file.path));
    const language = languageForPath(file.path);
    const model = monaco.editor.getModel(uri);

    if (model) {
      monaco.editor.setModelLanguage(model, language);
    } else {
      monaco.editor.createModel(file.content, language, uri);
    }
  }
}
