import type { ExplorerNode } from "./workspace";

export const joinPath = (parentPath: string, name: string) =>
  parentPath ? `${parentPath}/${name}` : name;

export const parentPathOf = (path: string) =>
  path.split("/").slice(0, -1).join("/");

/** "src/components" -> ["src", "src/components"] */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);

  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function collectFolderPaths(
  nodes: ExplorerNode[],
  into = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    if (node.kind === "folder") {
      into.add(node.path);
      collectFolderPaths(node.children, into);
    }
  }

  return into;
}

export function collectPaths(node: ExplorerNode, into: string[] = []): string[] {
  into.push(node.path);

  if (node.kind === "folder") {
    for (const child of node.children) {
      collectPaths(child, into);
    }
  }

  return into;
}

export function allPaths(
  nodes: ExplorerNode[],
  into = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    into.add(node.path);
    if (node.kind === "folder") {
      allPaths(node.children, into);
    }
  }

  return into;
}

export function findNode(
  nodes: ExplorerNode[],
  path: string,
): ExplorerNode | undefined {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }

    if (node.kind === "folder") {
      const match = findNode(node.children, path);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

export function firstFilePath(nodes: ExplorerNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind === "file") {
      return node.path;
    }

    const match = firstFilePath(node.children);
    if (match) {
      return match;
    }
  }

  return undefined;
}

const sortNodes = (nodes: ExplorerNode[]) =>
  [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

export function insertNode(
  nodes: ExplorerNode[],
  parentPath: string,
  node: ExplorerNode,
): ExplorerNode[] {
  if (parentPath === "") {
    return sortNodes([...nodes, node]);
  }

  return nodes.map((current) => {
    if (current.kind !== "folder") {
      return current;
    }

    if (current.path === parentPath) {
      return { ...current, children: sortNodes([...current.children, node]) };
    }

    return {
      ...current,
      children: insertNode(current.children, parentPath, node),
    };
  });
}

export function removeNode(
  nodes: ExplorerNode[],
  path: string,
): ExplorerNode[] {
  return nodes
    .filter((node) => node.path !== path)
    .map((node) =>
      node.kind === "folder"
        ? { ...node, children: removeNode(node.children, path) }
        : node,
    );
}

export type RenameResult = {
  nodes: ExplorerNode[];
  /** Old path -> new path for the renamed node and every descendant. */
  moved: Map<string, string>;
};

export function renameNode(
  nodes: ExplorerNode[],
  path: string,
  newName: string,
): RenameResult {
  const moved = new Map<string, string>();
  const newPath = joinPath(parentPathOf(path), newName);

  const rewrite = (node: ExplorerNode, isTarget: boolean): ExplorerNode => {
    const nextPath = isTarget
      ? newPath
      : `${newPath}${node.path.slice(path.length)}`;
    const nextName = isTarget ? newName : node.name;

    moved.set(node.path, nextPath);

    if (node.kind === "file") {
      return { kind: "file", name: nextName, path: nextPath };
    }

    return {
      kind: "folder",
      name: nextName,
      path: nextPath,
      children: node.children.map((child) => rewrite(child, false)),
    };
  };

  const walk = (list: ExplorerNode[]): ExplorerNode[] =>
    list.map((node) => {
      if (node.path === path) {
        return rewrite(node, true);
      }

      return node.kind === "folder"
        ? { ...node, children: walk(node.children) }
        : node;
    });

  return { nodes: sortNodes(walk(nodes)), moved };
}

export function migrateContents(
  contents: Record<string, string>,
  moved: Map<string, string>,
): Record<string, string> {
  const next = { ...contents };

  for (const [from, to] of moved) {
    if (from in next) {
      next[to] = next[from];
      delete next[from];
    }
  }

  return next;
}

export function omitPaths(
  contents: Record<string, string>,
  paths: string[],
): Record<string, string> {
  const next = { ...contents };

  for (const path of paths) {
    delete next[path];
  }

  return next;
}
