import {
  invoke,
  isTauri,
  pickFolder,
  pickNewProjectPath,
  toError,
} from "./tauriBridge";
import type { ExplorerNode, FolderNode } from "./workspace";
import { initialContents, initialTree } from "./workspace";

export type WorkspaceSnapshot = {
  root: string;
  name: string;
  tree: FolderNode;
};

type RawNode = {
  name: string;
  path: string;
  kind: "file" | "folder";
  children?: RawNode[];
};

type RawWorkspace = {
  root: string;
  name: string;
  children: RawNode[];
};

/** Browser builds have no filesystem, so they keep the sample project in memory. */
const demoContents = new Map<string, string>(Object.entries(initialContents));

function toExplorerNodes(nodes: RawNode[]): ExplorerNode[] {
  return nodes.map((node) =>
    node.kind === "folder"
      ? {
          kind: "folder" as const,
          name: node.name,
          path: node.path,
          children: toExplorerNodes(node.children ?? []),
        }
      : { kind: "file" as const, name: node.name, path: node.path },
  );
}

function toSnapshot(raw: RawWorkspace): WorkspaceSnapshot {
  return {
    root: raw.root,
    name: raw.name,
    tree: {
      kind: "folder",
      name: raw.name,
      path: "",
      children: toExplorerNodes(raw.children),
    },
  };
}

export function demoWorkspace(): WorkspaceSnapshot {
  return {
    root: "",
    name: "nexium-studio (demo)",
    tree: initialTree,
  };
}

export async function openFolder(): Promise<WorkspaceSnapshot | null> {
  if (!isTauri()) {
    return demoWorkspace();
  }

  const path = await pickFolder();

  if (!path) {
    return null;
  }

  try {
    return toSnapshot(await invoke<RawWorkspace>("open_workspace", { path }));
  } catch (cause) {
    throw toError(cause, "That folder could not be opened.");
  }
}

/** Creates an empty folder for a new project and opens it. */
export async function newProject(): Promise<WorkspaceSnapshot | null> {
  if (!isTauri()) {
    return demoWorkspace();
  }

  const path = await pickNewProjectPath();

  if (!path) {
    return null;
  }

  try {
    return toSnapshot(await invoke<RawWorkspace>("create_workspace", { path }));
  } catch (cause) {
    throw toError(cause, "That project could not be created.");
  }
}

/** Re-lists an open folder so files created on disk show up in the explorer. */
export async function refreshWorkspace(
  root: string,
): Promise<WorkspaceSnapshot> {
  if (!isTauri() || !root) {
    return demoWorkspace();
  }

  return toSnapshot(await invoke<RawWorkspace>("open_workspace", { path: root }));
}

/** Every TS/JS file in the folder, for the editor's TypeScript worker. */
export async function readWorkspaceSources(): Promise<
  { path: string; contents: string }[]
> {
  if (!isTauri()) {
    return [];
  }

  try {
    return await invoke<{ path: string; contents: string }[]>(
      "read_workspace_sources",
    );
  } catch (cause) {
    throw toError(cause, "Could not read the project sources.");
  }
}

export async function readFile(path: string): Promise<string> {
  if (isTauri()) {
    try {
      return await invoke<string>("read_workspace_file", { path });
    } catch (cause) {
      throw toError(cause, "That file could not be opened.");
    }
  }

  const demo = demoContents.get(path);

  if (demo === undefined) {
    throw new Error("The demo workspace only has its sample files.");
  }

  return demo;
}

export async function writeFile(
  path: string,
  contents: string,
): Promise<void> {
  if (isTauri()) {
    try {
      await invoke<void>("write_workspace_file", { path, contents });
    } catch (cause) {
      throw toError(cause, "That file could not be saved.");
    }
    return;
  }

  demoContents.set(path, contents);
}

export async function createEntry(
  parent: string,
  name: string,
  kind: "file" | "folder",
): Promise<string> {
  if (isTauri()) {
    try {
      return await invoke<string>("create_workspace_entry", {
        parent,
        name,
        kind,
      });
    } catch (cause) {
      throw toError(cause, "That could not be created.");
    }
  }

  const path = parent ? `${parent}/${name}` : name;

  if (kind === "file") {
    demoContents.set(path, "");
  }

  return path;
}

export async function renameEntry(from: string, to: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke<void>("rename_workspace_entry", { from, to });
    } catch (cause) {
      throw toError(cause, "That could not be renamed.");
    }
    return;
  }

  const existing = demoContents.get(from);

  if (existing !== undefined) {
    demoContents.set(to, existing);
    demoContents.delete(from);
  }
}

export async function deleteEntry(path: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke<void>("delete_workspace_entry", { path });
    } catch (cause) {
      throw toError(cause, "That could not be deleted.");
    }
    return;
  }

  for (const key of [...demoContents.keys()]) {
    if (key === path || key.startsWith(`${path}/`)) {
      demoContents.delete(key);
    }
  }
}
