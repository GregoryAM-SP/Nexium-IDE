import {
  AlertTriangle,
  Coffee,
  FolderCog,
  Hammer,
  LoaderCircle,
  Smartphone,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  applyGradleSettings,
  jdkLabel,
  readGradleSettings,
} from "../lib/gradleSettings";
import type {
  GradleSettings,
  ModuleKey,
  ModuleSettings,
  SettingEdit,
} from "../lib/gradleSettings";

type ProjectSettingsDialogProps = {
  projectName: string;
  /** False when the open folder has no Gradle build. */
  gradleDetected: boolean;
  /** The JDK that runs Gradle on this machine; empty for JAVA_HOME. */
  gradleJvm: string;
  /** Called after saving with the files that changed and the chosen JDK. */
  onSaved: (changed: string[], gradleJvm: string) => void;
  onClose: () => void;
};

const MODULE_KEYS: ModuleKey[] = [
  "toolchain",
  "sourceCompatibility",
  "targetCompatibility",
  "compileSdk",
  "minSdk",
  "targetSdk",
];

const COMMON_JAVA = ["8", "11", "17", "21", "25"];

const TOGGLES: { key: string; label: string; hint: string }[] = [
  { key: "org.gradle.parallel", label: "Parallel builds", hint: "Build independent projects at the same time" },
  { key: "org.gradle.caching", label: "Build cache", hint: "Reuse task outputs from earlier builds" },
  { key: "org.gradle.configuration-cache", label: "Configuration cache", hint: "Skip the configuration phase when nothing changed" },
  { key: "org.gradle.daemon", label: "Gradle daemon", hint: "Keep Gradle running between builds" },
];

const CUSTOM = "__custom__";

type ModuleValues = Record<ModuleKey, string>;

type FormState = {
  jvm: string;
  jvmCustom: boolean;
  wrapperVersion: string;
  jvmArgs: string;
  javaHomeProperty: string;
  toggles: Record<string, string>;
  sdkDir: string;
  sdkCustom: boolean;
  modules: Record<string, ModuleValues>;
};

function moduleValues(module: ModuleSettings): ModuleValues {
  return {
    toolchain: module.toolchain ?? "",
    sourceCompatibility: module.sourceCompatibility ?? "",
    targetCompatibility: module.targetCompatibility ?? "",
    compileSdk: module.compileSdk ?? "",
    minSdk: module.minSdk ?? "",
    targetSdk: module.targetSdk ?? "",
  };
}

function initialForm(settings: GradleSettings, gradleJvm: string): FormState {
  const knownJdk = settings.jdks.some((jdk) => jdk.path === gradleJvm);
  const knownSdk = settings.androidSdks.some(
    (sdk) => sdk.path === settings.androidSdkDir,
  );

  return {
    jvm: gradleJvm,
    jvmCustom: gradleJvm !== "" && !knownJdk,
    wrapperVersion: settings.wrapperVersion ?? "",
    jvmArgs: settings.properties["org.gradle.jvmargs"] ?? "",
    javaHomeProperty: settings.properties["org.gradle.java.home"] ?? "",
    toggles: Object.fromEntries(
      TOGGLES.map(({ key }) => [key, settings.properties[key] ?? ""]),
    ),
    sdkDir: settings.androidSdkDir ?? "",
    sdkCustom: Boolean(settings.androidSdkDir) && !knownSdk,
    modules: Object.fromEntries(
      settings.modules.map((module) => [module.path, moduleValues(module)]),
    ),
  };
}

/** Only what differs from the files is written. */
function collectEdits(settings: GradleSettings, form: FormState): SettingEdit[] {
  const edits: SettingEdit[] = [];
  const property = (key: string, value: string) => {
    const before = settings.properties[key] ?? "";
    if (value.trim() !== before) {
      edits.push({
        target: "gradle.properties",
        key,
        value: value.trim() || null,
      });
    }
  };

  if (
    settings.wrapperVersion &&
    form.wrapperVersion.trim() !== settings.wrapperVersion
  ) {
    edits.push({ target: "wrapper", key: "version", value: form.wrapperVersion.trim() });
  }

  property("org.gradle.jvmargs", form.jvmArgs);
  property("org.gradle.java.home", form.javaHomeProperty);

  for (const { key } of TOGGLES) {
    property(key, form.toggles[key] ?? "");
  }

  if (form.sdkDir.trim() !== (settings.androidSdkDir ?? "")) {
    edits.push({
      target: "local.properties",
      key: "sdk.dir",
      value: form.sdkDir.trim() || null,
    });
  }

  for (const module of settings.modules) {
    const before = moduleValues(module);
    const after = form.modules[module.path];

    for (const key of MODULE_KEYS) {
      if (after && after[key].trim() && after[key].trim() !== before[key]) {
        edits.push({
          target: "module",
          project: module.path,
          key,
          value: after[key].trim(),
        });
      }
    }
  }

  return edits;
}

function editFile(edit: SettingEdit, settings: GradleSettings): string {
  if (edit.target === "wrapper") {
    return "gradle-wrapper.properties";
  }

  if (edit.target === "module") {
    return (
      settings.modules.find((module) => module.path === edit.project)?.buildFile ??
      edit.project
    );
  }

  return edit.target;
}

const inputClass =
  "h-8 w-full min-w-0 rounded-lg border border-line bg-app px-2.5 text-[12px] text-ink placeholder:text-ink/20 focus:border-ink/25 focus:outline-none";
const monoInputClass = `${inputClass} font-mono text-[11.5px]`;

function Section({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-ink/[0.06] px-5 py-4 first:border-t-0">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-ink/40" strokeWidth={1.75} />
        <h3 className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink/45">
          {title}
        </h3>
        {subtitle && (
          <span className="truncate font-mono text-[10px] text-ink/25">
            {subtitle}
          </span>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[148px_minmax(0,1fr)] items-start gap-3">
      <div className="pt-[7px]">
        <p className="text-[11.5px] text-ink/70">{label}</p>
      </div>
      <div className="min-w-0">
        {children}
        {hint && (
          <p className="mt-1 text-[10.5px] leading-relaxed text-ink/30">{hint}</p>
        )}
      </div>
    </div>
  );
}

function TriState({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const options: [string, string][] = [
    ["", "Default"],
    ["true", "On"],
    ["false", "Off"],
  ];

  return (
    <div className="inline-flex rounded-lg border border-line bg-app p-0.5">
      {options.map(([option, label]) => (
        <button
          key={label}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`h-6 rounded-md px-2.5 text-[11px] transition-colors duration-150 ${
            value === option
              ? "bg-ink/[0.1] text-ink"
              : "text-ink/40 hover:text-ink/75"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function JavaVersionSelect({
  value,
  original,
  versions,
  allowUnset,
  legacyNames,
  onChange,
}: {
  value: string;
  original: string;
  versions: string[];
  allowUnset: boolean;
  /** Compatibility settings spell Java 8 as 1.8. */
  legacyNames: boolean;
  onChange: (value: string) => void;
}) {
  const options = useMemo(() => {
    const list = versions.map((version) =>
      legacyNames && version === "8" ? "1.8" : version,
    );

    for (const extra of [original, value]) {
      if (extra && !list.includes(extra)) {
        list.push(extra);
      }
    }

    return list.sort((left, right) => parseFloat(right) - parseFloat(left));
  }, [versions, legacyNames, original, value]);

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`${inputClass} pr-7`}
    >
      {allowUnset && <option value="">Not set</option>}
      {options.map((option) => (
        <option key={option} value={option}>
          {/^\d+(\.\d+)?$/.test(option) ? `Java ${option}` : option}
        </option>
      ))}
    </select>
  );
}

export default function ProjectSettingsDialog({
  projectName,
  gradleDetected,
  gradleJvm,
  onSaved,
  onClose,
}: ProjectSettingsDialogProps) {
  const [settings, setSettings] = useState<GradleSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!gradleDetected) {
      return;
    }

    let cancelled = false;

    void readGradleSettings()
      .then((loaded) => {
        if (!cancelled) {
          setSettings(loaded);
          setForm(initialForm(loaded, gradleJvm));
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) {
          setLoadError(cause.message);
        }
      });

    return () => {
      cancelled = true;
    };
    // Read once per opening; the form owns the values after that.
  }, []);

  // Escape closes, but never in the middle of a save.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [saving, onClose]);

  const edits = useMemo(
    () => (settings && form ? collectEdits(settings, form) : []),
    [settings, form],
  );
  const jvmChanged = form !== null && form.jvm.trim() !== gradleJvm;
  const dirty = edits.length > 0 || jvmChanged;
  const touchedFiles = settings
    ? [...new Set(edits.map((edit) => editFile(edit, settings)))]
    : [];

  const javaVersions = useMemo(() => {
    const majors = new Set(COMMON_JAVA);
    for (const jdk of settings?.jdks ?? []) {
      if (jdk.major >= 8) {
        majors.add(String(jdk.major));
      }
    }
    return [...majors];
  }, [settings]);

  const sdkPlatforms = useMemo(() => {
    const active =
      settings?.androidSdks.find((sdk) => sdk.path === form?.sdkDir) ??
      settings?.androidSdks[0];
    return active?.platforms ?? [];
  }, [settings, form?.sdkDir]);

  const update = (change: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...change } : current));

  const updateModule = (path: string, key: ModuleKey, value: string) =>
    setForm((current) =>
      current
        ? {
            ...current,
            modules: {
              ...current.modules,
              [path]: { ...current.modules[path], [key]: value },
            },
          }
        : current,
    );

  const save = async () => {
    if (!form || !dirty || saving) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const changed = edits.length > 0 ? await applyGradleSettings(edits) : [];
      onSaved(changed, form.jvm.trim());
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Saving failed.");
    } finally {
      setSaving(false);
    }
  };

  const androidUsed =
    settings !== null &&
    (settings.androidSdkDir !== null ||
      settings.modules.some((module) => module.android));

  let body: ReactNode;

  if (!gradleDetected) {
    body = (
      <div className="px-5 py-8 text-center">
        <p className="text-[12.5px] text-ink/65">No Gradle build</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[11.5px] leading-relaxed text-ink/35">
          Project settings cover Gradle builds: JDK, SDK and Gradle versions.
          This folder has no settings.gradle or build.gradle at its root.
        </p>
      </div>
    );
  } else if (loadError) {
    body = (
      <p className="mx-5 my-5 flex items-start gap-2 rounded-lg border border-ink/15 bg-ink/[0.05] px-3 py-2 text-[11.5px] text-ink/75">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
        {loadError}
      </p>
    );
  } else if (!settings || !form) {
    body = (
      <div className="flex items-center justify-center gap-2 py-12 text-[11.5px] text-ink/40">
        <LoaderCircle className="size-3.5 animate-spin" />
        Reading the build and looking for installed JDKs…
      </div>
    );
  } else {
    const jvmSelectValue = form.jvmCustom ? CUSTOM : form.jvm;
    const sdkSelectValue = form.sdkCustom ? CUSTOM : form.sdkDir;

    body = (
      <>
        <Section icon={Hammer} title="Gradle">
          <Field
            label="Gradle JDK"
            hint={
              form.javaHomeProperty
                ? "org.gradle.java.home in gradle.properties is set and takes precedence over this."
                : "Runs Gradle and its tasks. Saved for this machine only, never written to the project."
            }
          >
            <select
              value={jvmSelectValue}
              onChange={(event) => {
                const value = event.target.value;
                update(
                  value === CUSTOM
                    ? { jvmCustom: true }
                    : { jvm: value, jvmCustom: false },
                );
              }}
              className={`${inputClass} pr-7`}
            >
              <option value="">Default (JAVA_HOME)</option>
              {settings.jdks.map((jdk) => (
                <option key={jdk.path} value={jdk.path}>
                  {`JDK ${jdk.major || "?"} — ${jdkLabel(jdk)}`}
                </option>
              ))}
              <option value={CUSTOM}>Other location…</option>
            </select>
            {form.jvmCustom && (
              <input
                value={form.jvm}
                onChange={(event) => update({ jvm: event.target.value })}
                placeholder="Path to a JDK folder"
                spellCheck={false}
                className={`${monoInputClass} mt-1.5`}
              />
            )}
            {!form.jvmCustom && form.jvm && (
              <p className="mt-1 truncate font-mono text-[10px] text-ink/25">
                {form.jvm}
              </p>
            )}
          </Field>

          <Field
            label="Gradle version"
            hint={
              settings.wrapperVersion
                ? "Changes the wrapper's distribution; it is downloaded on the next run."
                : "This build has no Gradle wrapper, so the gradle on your PATH is used."
            }
          >
            <input
              value={form.wrapperVersion}
              onChange={(event) => update({ wrapperVersion: event.target.value })}
              disabled={!settings.wrapperVersion}
              placeholder={settings.wrapperVersion ? "8.10.2" : "No wrapper"}
              spellCheck={false}
              className={`${monoInputClass} disabled:opacity-50`}
            />
          </Field>
        </Section>

        <Section icon={SlidersHorizontal} title="Gradle properties" subtitle="gradle.properties">
          <Field label="JVM arguments" hint="Memory and flags for the Gradle daemon, e.g. -Xmx4g.">
            <input
              value={form.jvmArgs}
              onChange={(event) => update({ jvmArgs: event.target.value })}
              placeholder="-Xmx2048m -Dfile.encoding=UTF-8"
              spellCheck={false}
              className={monoInputClass}
            />
          </Field>

          {TOGGLES.map((toggle) => (
            <Field key={toggle.key} label={toggle.label} hint={toggle.hint}>
              <TriState
                value={form.toggles[toggle.key] ?? ""}
                onChange={(value) =>
                  update({ toggles: { ...form.toggles, [toggle.key]: value } })
                }
              />
            </Field>
          ))}

          <Field
            label="Shared JDK path"
            hint="org.gradle.java.home — shared with everyone who uses the repository. Leave empty to use the Gradle JDK above."
          >
            <input
              value={form.javaHomeProperty}
              onChange={(event) => update({ javaHomeProperty: event.target.value })}
              placeholder="Not set"
              spellCheck={false}
              className={monoInputClass}
            />
          </Field>
        </Section>

        {androidUsed && (
          <Section icon={Smartphone} title="Android SDK" subtitle="local.properties">
            <Field
              label="SDK location"
              hint={
                sdkPlatforms.length > 0
                  ? `Installed platforms: ${sdkPlatforms.slice(0, 8).join(", ")}${sdkPlatforms.length > 8 ? "…" : ""}`
                  : "Usually kept out of version control."
              }
            >
              <select
                value={sdkSelectValue}
                onChange={(event) => {
                  const value = event.target.value;
                  update(
                    value === CUSTOM
                      ? { sdkCustom: true }
                      : { sdkDir: value, sdkCustom: false },
                  );
                }}
                className={`${inputClass} pr-7`}
              >
                <option value="">Not set (ANDROID_HOME)</option>
                {settings.androidSdks.map((sdk) => (
                  <option key={sdk.path} value={sdk.path}>
                    {sdk.path}
                  </option>
                ))}
                <option value={CUSTOM}>Other location…</option>
              </select>
              {form.sdkCustom && (
                <input
                  value={form.sdkDir}
                  onChange={(event) => update({ sdkDir: event.target.value })}
                  placeholder="Path to the Android SDK"
                  spellCheck={false}
                  className={`${monoInputClass} mt-1.5`}
                />
              )}
            </Field>
          </Section>
        )}

        {settings.modules.map((module) => {
          const values = form.modules[module.path];
          const original = moduleValues(module);
          const hasJava =
            module.toolchain !== null ||
            module.sourceCompatibility !== null ||
            module.targetCompatibility !== null ||
            !module.android;
          const sdkFields: [ModuleKey, string][] = (
            [
              ["compileSdk", "Compile SDK"],
              ["minSdk", "Minimum SDK"],
              ["targetSdk", "Target SDK"],
            ] as [ModuleKey, string][]
          ).filter(([key]) => module[key] !== null);

          if (!values || (!hasJava && sdkFields.length === 0)) {
            return null;
          }

          return (
            <Section
              key={module.path}
              icon={module.android ? Smartphone : Coffee}
              title={module.path === ":" ? `${module.name} (root)` : module.name}
              subtitle={module.buildFile}
            >
              {hasJava && (
                <Field
                  label="Java toolchain"
                  hint={
                    module.toolchain === null
                      ? `Not set. Choosing a version adds a ${module.kotlin ? "kotlin { jvmToolchain(…) }" : "java { toolchain { … } }"} block.`
                      : "The JDK version this module compiles and runs with."
                  }
                >
                  <JavaVersionSelect
                    value={values.toolchain}
                    original={original.toolchain}
                    versions={javaVersions}
                    allowUnset={module.toolchain === null}
                    legacyNames={false}
                    onChange={(value) => updateModule(module.path, "toolchain", value)}
                  />
                </Field>
              )}

              {(["sourceCompatibility", "targetCompatibility"] as const)
                .filter((key) => module[key] !== null)
                .map((key) => (
                  <Field
                    key={key}
                    label={key === "sourceCompatibility" ? "Source compatibility" : "Target compatibility"}
                  >
                    <JavaVersionSelect
                      value={values[key]}
                      original={original[key]}
                      versions={javaVersions}
                      allowUnset={false}
                      legacyNames
                      onChange={(value) => updateModule(module.path, key, value)}
                    />
                  </Field>
                ))}

              {sdkFields.map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    value={values[key]}
                    onChange={(event) => updateModule(module.path, key, event.target.value)}
                    list={sdkPlatforms.length > 0 ? "nexium-android-platforms" : undefined}
                    spellCheck={false}
                    className={monoInputClass}
                  />
                </Field>
              ))}
            </Section>
          );
        })}

        <datalist id="nexium-android-platforms">
          {sdkPlatforms.map((level) => (
            <option key={level} value={String(level)} />
          ))}
        </datalist>
      </>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) {
          onClose();
        }
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex max-h-[88vh] w-full max-w-[620px] flex-col rounded-2xl border border-ink/10 bg-raised shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)]"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-ink/[0.08] px-5 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] ring-1 ring-ink/10 ring-inset">
            <FolderCog className="size-4 text-ink/70" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="project-settings-title"
              className="text-[13.5px] font-semibold text-ink/90"
            >
              Project settings
            </h2>
            <p className="mt-1 truncate text-[11.5px] text-ink/45">
              JDK, SDK and Gradle configuration for {projectName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink/35 transition-colors duration-150 hover:bg-ink/[0.07] hover:text-ink disabled:opacity-40"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>

        {saveError && (
          <p
            role="alert"
            className="mx-5 mb-3 flex shrink-0 items-start gap-2 rounded-lg border border-ink/15 bg-ink/[0.05] px-3 py-2 text-[11px] leading-relaxed text-ink/75"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            {saveError}
          </p>
        )}

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink/[0.08] px-5 py-3">
          <span className="min-w-0 truncate text-[10.5px] text-ink/30">
            {touchedFiles.length > 0
              ? `Writes ${touchedFiles.join(", ")}`
              : jvmChanged
                ? "Saves the Gradle JDK for this machine"
                : "No changes"}
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-7 rounded-md border border-ink/10 bg-ink/[0.02] px-3 text-[11.5px] text-ink/60 transition-colors duration-150 hover:border-ink/20 hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40"
            >
              {gradleDetected ? "Cancel" : "Close"}
            </button>
            {gradleDetected && (
              <button
                type="submit"
                disabled={!dirty || saving}
                className="flex h-7 items-center gap-1.5 rounded-md bg-ink px-3 text-[11.5px] font-medium text-app transition-colors duration-150 hover:bg-ink/90 disabled:bg-ink/[0.08] disabled:text-ink/30"
              >
                {saving && <LoaderCircle className="size-3.5 animate-spin" />}
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>,
    document.body,
  );
}
