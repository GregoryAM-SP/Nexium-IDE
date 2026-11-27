import { invoke, isTauri, toError } from "./tauriBridge";

export type GradleTaskKind = "run" | "build" | "test" | "custom" | "other";

export type GradleTask = {
  name: string;
  /** What Gradle is asked to run, e.g. `:app:run`. */
  path: string;
  kind: GradleTaskKind;
  description: string;
};

export type GradleProject = {
  /** `:` for the root project, `:app` for a subproject. */
  path: string;
  name: string;
  dir: string;
  buildFile: string | null;
  plugins: string[];
  tasks: GradleTask[];
};

export type GradleInfo = {
  detected: boolean;
  rootName: string;
  hasWrapper: boolean;
  settingsFile: string | null;
  /** The command prefix that runs Gradle in the terminal's shell. */
  launcher: string;
  /** The terminal runs PowerShell on Windows and a POSIX shell elsewhere. */
  windows: boolean;
  projects: GradleProject[];
};

/** The browser build has no filesystem, so the panel shows a sample build. */
const demo: GradleInfo = {
  detected: true,
  rootName: "sample-app",
  hasWrapper: true,
  settingsFile: "settings.gradle.kts",
  launcher: "./gradlew",
  windows: false,
  projects: [
    {
      path: ":",
      name: "sample-app",
      dir: "",
      buildFile: "build.gradle.kts",
      plugins: [],
      tasks: [
        { name: "build", path: "build", kind: "build", description: "Assemble and test this project" },
        { name: "clean", path: "clean", kind: "build", description: "Delete the build directory" },
      ],
    },
    {
      path: ":server",
      name: "server",
      dir: "server",
      buildFile: "server/build.gradle.kts",
      plugins: ["Kotlin", "Spring Boot"],
      tasks: [
        { name: "bootRun", path: ":server:bootRun", kind: "run", description: "Run the Spring Boot application" },
        { name: "test", path: ":server:test", kind: "test", description: "Run the unit tests" },
        { name: "build", path: ":server:build", kind: "build", description: "Assemble and test this project" },
      ],
    },
  ],
};

export async function detectGradle(): Promise<GradleInfo> {
  if (!isTauri()) {
    return demo;
  }

  try {
    return await invoke<GradleInfo>("gradle_detect");
  } catch (cause) {
    throw toError(cause, "The Gradle build could not be read.");
  }
}

/** Asks Gradle itself for every task; slow the first time a daemon starts. */
export async function queryGradleTasks(
  javaHome = "",
): Promise<GradleTask[]> {
  if (!isTauri()) {
    return demo.projects.flatMap((project) => project.tasks);
  }

  try {
    return await invoke<GradleTask[]>("gradle_tasks", {
      javaHome: javaHome || null,
    });
  } catch (cause) {
    throw toError(cause, "Gradle could not list the tasks.");
  }
}

/**
 * The line typed into the terminal to run one task. A chosen JDK applies to
 * this run only, so the shell's own JAVA_HOME is unchanged afterwards.
 */
export function gradleCommand(
  info: GradleInfo,
  task: GradleTask,
  javaHome = "",
): string {
  const run = `${info.launcher} ${task.path}`;

  if (!javaHome) {
    return run;
  }

  if (info.windows) {
    const quoted = `'${javaHome.replace(/'/g, "''")}'`;
    return `& { $previous = $env:JAVA_HOME; $env:JAVA_HOME = ${quoted}; try { ${run} } finally { $env:JAVA_HOME = $previous } }`;
  }

  return `JAVA_HOME='${javaHome.replace(/'/g, `'\\''`)}' ${run}`;
}

/** Workspace files whose change can add or remove tasks. */
export function isGradleScript(path: string): boolean {
  return /(^|\/)(settings|build)\.gradle(\.kts)?$/.test(path);
}
