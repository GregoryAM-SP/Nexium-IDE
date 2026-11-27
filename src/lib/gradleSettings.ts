import { invoke, isTauri, toError } from "./tauriBridge";

export type JdkInstall = {
  path: string;
  version: string;
  major: number;
  vendor: string;
};

export type AndroidSdk = {
  path: string;
  /** Installed platform API levels, newest first. */
  platforms: number[];
};

export type ModuleSettings = {
  path: string;
  name: string;
  buildFile: string;
  android: boolean;
  kotlin: boolean;
  toolchain: string | null;
  sourceCompatibility: string | null;
  targetCompatibility: string | null;
  compileSdk: string | null;
  minSdk: string | null;
  targetSdk: string | null;
};

export type GradleSettings = {
  wrapperVersion: string | null;
  properties: Record<string, string>;
  androidSdkDir: string | null;
  modules: ModuleSettings[];
  jdks: JdkInstall[];
  androidSdks: AndroidSdk[];
};

export type ModuleKey =
  | "toolchain"
  | "sourceCompatibility"
  | "targetCompatibility"
  | "compileSdk"
  | "minSdk"
  | "targetSdk";

/** One change; a null value removes a property. */
export type SettingEdit =
  | { target: "gradle.properties" | "local.properties"; key: string; value: string | null }
  | { target: "wrapper"; key: "version"; value: string }
  | { target: "module"; project: string; key: ModuleKey; value: string };

/** The browser build has no filesystem, so the dialog edits a sample build. */
let demo: GradleSettings = {
  wrapperVersion: "8.10.2",
  properties: {
    "org.gradle.jvmargs": "-Xmx2048m -Dfile.encoding=UTF-8",
    "org.gradle.parallel": "true",
  },
  androidSdkDir: null,
  modules: [
    {
      path: ":server",
      name: "server",
      buildFile: "server/build.gradle.kts",
      android: false,
      kotlin: true,
      toolchain: "17",
      sourceCompatibility: null,
      targetCompatibility: null,
      compileSdk: null,
      minSdk: null,
      targetSdk: null,
    },
  ],
  jdks: [
    { path: "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot", version: "21.0.5", major: 21, vendor: "Eclipse Adoptium" },
    { path: "C:\\Program Files\\Java\\jdk-17", version: "17.0.12", major: 17, vendor: "Oracle Corporation" },
  ],
  androidSdks: [],
};

export async function readGradleSettings(): Promise<GradleSettings> {
  if (!isTauri()) {
    return structuredClone(demo);
  }

  try {
    return await invoke<GradleSettings>("gradle_settings");
  } catch (cause) {
    throw toError(cause, "The Gradle settings could not be read.");
  }
}

/** Resolves to the files that changed. */
export async function applyGradleSettings(
  edits: SettingEdit[],
): Promise<string[]> {
  if (!isTauri()) {
    for (const edit of edits) {
      if (edit.target === "wrapper") {
        demo.wrapperVersion = edit.value;
      } else if (edit.target === "module") {
        const module = demo.modules.find((entry) => entry.path === edit.project);
        if (module) {
          module[edit.key] = edit.value;
        }
      } else if (edit.target === "local.properties") {
        demo.androidSdkDir = edit.value;
      } else if (edit.value === null) {
        delete demo.properties[edit.key];
      } else {
        demo.properties[edit.key] = edit.value;
      }
    }

    demo = structuredClone(demo);
    return edits.map((edit) => edit.target);
  }

  try {
    return await invoke<string[]>("gradle_settings_apply", { edits });
  } catch (cause) {
    throw toError(cause, "The Gradle settings could not be saved.");
  }
}

// The JDK that runs Gradle is a property of this machine, not of the
// repository, so it is kept locally per project folder rather than written to
// a file someone might commit.
const JVM_KEY = "nexium.gradle.jvm:";

export function loadGradleJvm(root: string): string {
  return localStorage.getItem(JVM_KEY + root) ?? "";
}

export function saveGradleJvm(root: string, javaHome: string): void {
  if (javaHome) {
    localStorage.setItem(JVM_KEY + root, javaHome);
  } else {
    localStorage.removeItem(JVM_KEY + root);
  }
}

export function jdkLabel(jdk: JdkInstall): string {
  const version = jdk.version || (jdk.major ? String(jdk.major) : "unknown version");
  return jdk.vendor ? `${version} · ${jdk.vendor}` : version;
}
