import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import { registerInlineCompletions } from "./inlineCompletion";
import type { SyntaxPalette } from "./themes";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

type WorkerConstructor = new () => Worker;

const workers: Record<string, WorkerConstructor> = {
  css: cssWorker,
  scss: cssWorker,
  less: cssWorker,
  html: htmlWorker,
  handlebars: htmlWorker,
  razor: htmlWorker,
  json: jsonWorker,
  typescript: tsWorker,
  javascript: tsWorker,
};

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker;
    };
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId, label) {
    const Worker = workers[label] ?? editorWorker;
    return new Worker();
  },
};

// Monaco ships 84 grammars but no TOML, which is the format of Cargo.toml and
// pyproject.toml, so a compact Monarch grammar fills the gap.
monaco.languages.register({
  id: "toml",
  extensions: [".toml"],
  aliases: ["TOML", "toml"],
});

monaco.languages.setLanguageConfiguration("toml", {
  comments: { lineComment: "#" },
  brackets: [
    ["[", "]"],
    ["{", "}"],
  ],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: "{", close: "}" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
});

monaco.languages.setMonarchTokensProvider("toml", {
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/^\s*\[\[?.*?\]\]?\s*$/, "type"],
      [/"""/, { token: "string", next: "@multiBasic" }],
      [/'''/, { token: "string", next: "@multiLiteral" }],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/'[^']*'/, "string"],
      [/\b(?:true|false)\b/, "keyword"],
      [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?\b/, "number"],
      [/\b(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+)\b/, "number"],
      [/[+-]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/, "number"],
      [/[A-Za-z_][\w.-]*(?=\s*=)/, "attribute.name"],
      [/[[\]{}.,=]/, "delimiter"],
    ],
    multiBasic: [
      [/"""/, { token: "string", next: "@pop" }],
      [/./, "string"],
    ],
    multiLiteral: [
      [/'''/, { token: "string", next: "@pop" }],
      [/./, "string"],
    ],
  },
});

export type EditorTheme = {
  scheme: "dark" | "light";
  bg: string;
  fg: string;
  accent: string;
  syntax: SyntaxPalette;
};

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : value;

  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([red, green, blue]: [number, number, number]): string {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** `amount` of `fg` blended into `bg`, which is how the app mixes its tokens. */
function blend(fg: string, bg: string, amount: number): string {
  const [fr, fg_, fb] = channels(fg);
  const [br, bg_, bb] = channels(bg);

  return toHex([
    fr * amount + br * (1 - amount),
    fg_ * amount + bg_ * (1 - amount),
    fb * amount + bb * (1 - amount),
  ]);
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio between two opaque colours, from 1 to 21. */
function monacoContrast(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (left, right) => right - left,
  );

  return (lighter + 0.05) / (darker + 0.05);
}

function alpha(hex: string, amount: number): string {
  const [red, green, blue] = channels(hex);
  const alphaHex = Math.round(amount * 255)
    .toString(16)
    .padStart(2, "0");

  return `${toHex([red, green, blue])}${alphaHex}`;
}

/**
 * Monaco cannot read CSS variables, so the active theme is translated into a
 * concrete palette whenever it changes: the editor keeps the same monochrome
 * syntax treatment, drawn with the theme's ink and accent.
 */
export function applyEditorTheme(theme: EditorTheme) {
  const dark = theme.scheme === "dark";
  const ink = (amount: number) => blend(theme.fg, theme.bg, amount);
  const surface = (amount: number) => blend(theme.fg, theme.bg, amount);
  const rule = (amount: number) => ink(amount).slice(1);
  const syntax = theme.syntax;
  const token = (hex: string) => hex.slice(1);
  // Keywords and tags wear the theme accent, so code carries the colour of the
  // chosen theme; literals, comments, types and attributes keep the palette, so
  // a theme lends part of its colour instead of repainting every token. The
  // shared palettes are the themes that have no syntax colours of their own, so
  // those are the ones that borrow the accent; a curated palette (Dracula, Nord,
  // Monokai…) already matches its theme and is left alone. A neutral accent
  // has no hue to lend, so it also keeps the palette untouched.
  const [accentR, accentG, accentB] = channels(theme.accent);
  const accentChroma =
    (Math.max(accentR, accentG, accentB) - Math.min(accentR, accentG, accentB)) /
    255;
  const accentsCode = Boolean(syntax.accentFromTheme) && accentChroma >= 0.12;

  /** Darken toward the ink until the accent is readable on this background. */
  const readable = (color: string): string => {
    for (let step = 0; step <= 8; step += 1) {
      const candidate = blend(color, theme.fg, 1 - step / 10);

      if (monacoContrast(candidate, theme.bg) >= 4.5) {
        return candidate;
      }
    }

    return theme.fg;
  };

  const keywords = accentsCode ? readable(theme.accent) : syntax.keyword;
  const tags = accentsCode
    ? readable(blend(theme.accent, theme.fg, 0.8))
    : syntax.tag;
  const attributes = syntax.attributeName;
  const types = syntax.type;
  const functions = syntax.function;
  const operators = syntax.operator;
  const delimiters = syntax.delimiter;

  monaco.editor.defineTheme("nexium", {
    base: dark ? "vs-dark" : "vs",
    // Inheriting the base theme kept its blue/gold scopes for whatever this
    // palette does not name, which made HTML look half-highlighted. Every scope
    // is either styled here or falls back to the theme's own foreground.
    inherit: false,
    rules: [
      { token: "", foreground: rule(0.88) },
      { token: "comment", foreground: token(syntax.comment), fontStyle: "italic" },
      { token: "keyword", foreground: token(keywords), fontStyle: "bold" },
      { token: "string", foreground: token(syntax.string) },
      { token: "number", foreground: token(syntax.number) },
      { token: "regexp", foreground: token(syntax.regexp) },
      { token: "type", foreground: token(types) },
      { token: "identifier", foreground: rule(0.88) },
      { token: "variable", foreground: token(syntax.variable) },
      { token: "function", foreground: token(functions) },
      { token: "constant", foreground: token(syntax.constant) },
      { token: "namespace", foreground: token(types) },
      { token: "key", foreground: token(attributes) },
      { token: "annotation", foreground: token(syntax.meta) },
      { token: "delimiter", foreground: token(delimiters) },
      { token: "operator", foreground: token(operators) },
      { token: "tag", foreground: token(tags) },
      { token: "attribute.name", foreground: token(attributes) },
      { token: "attribute.value", foreground: token(syntax.attributeValue) },
      { token: "metatag", foreground: token(syntax.meta) },
      { token: "meta", foreground: token(syntax.meta) },
      { token: "emphasis", fontStyle: "italic" },
      { token: "strong", fontStyle: "bold" },
      { token: "invalid", foreground: token(syntax.invalid) },
    ],
    colors: {
      "editor.background": theme.bg,
      "editor.foreground": ink(0.86),
      "editorGutter.background": theme.bg,
      "editorLineNumber.foreground": ink(0.22),
      "editorLineNumber.activeForeground": ink(0.62),
      "editor.lineHighlightBackground": alpha(theme.fg, 0.035),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": alpha(theme.accent, dark ? 0.28 : 0.22),
      "editor.inactiveSelectionBackground": alpha(theme.accent, 0.14),
      "editor.selectionHighlightBackground": alpha(theme.fg, 0.07),
      "editor.wordHighlightBackground": alpha(theme.fg, 0.07),
      "editor.wordHighlightStrongBackground": alpha(theme.fg, 0.13),
      "editor.findMatchBackground": alpha(theme.accent, 0.42),
      "editor.findMatchHighlightBackground": alpha(theme.accent, 0.18),
      "editorCursor.foreground": theme.accent,
      "editorWhitespace.foreground": alpha(theme.fg, 0.08),
      "editorIndentGuide.background1": alpha(theme.fg, 0.06),
      "editorIndentGuide.activeBackground1": alpha(theme.fg, 0.18),
      "editorBracketMatch.background": alpha(theme.fg, 0.07),
      "editorBracketMatch.border": alpha(theme.fg, 0.25),
      // Bracket colourisation defaults to a rainbow (gold, orchid…), which would
      // break the palette, so each nesting level is an ink shade instead.
      "editorBracketHighlight.foreground1": tags,
      "editorBracketHighlight.foreground2": syntax.number,
      "editorBracketHighlight.foreground3": syntax.string,
      "editorBracketHighlight.foreground4": types,
      "editorBracketHighlight.foreground5": keywords,
      "editorBracketHighlight.foreground6": functions,
      "editorBracketHighlight.unexpectedBracket.foreground": ink(0.5),
      "editorBracketPairGuide.background1": alpha(theme.fg, 0.05),
      "editorBracketPairGuide.activeBackground1": alpha(theme.fg, 0.14),
      "editorOverviewRuler.border": "#00000000",
      "editorError.foreground": ink(0.4),
      "editorWarning.foreground": ink(0.34),
      "editorWidget.background": surface(0.06),
      "editorWidget.border": alpha(theme.fg, 0.12),
      "editorWidget.foreground": ink(0.86),
      "editorHoverWidget.background": surface(0.06),
      "editorHoverWidget.border": alpha(theme.fg, 0.12),
      "editorSuggestWidget.background": surface(0.06),
      "editorSuggestWidget.border": alpha(theme.fg, 0.12),
      "editorSuggestWidget.foreground": ink(0.86),
      "editorSuggestWidget.selectedBackground": alpha(theme.fg, 0.09),
      "editorSuggestWidget.highlightForeground": theme.accent,
      "input.background": theme.bg,
      "input.border": alpha(theme.fg, 0.12),
      "focusBorder": alpha(theme.accent, 0.4),
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": alpha(theme.fg, 0.1),
      "scrollbarSlider.hoverBackground": alpha(theme.fg, 0.16),
      "scrollbarSlider.activeBackground": alpha(theme.fg, 0.22),
    },
  });

  monaco.editor.setTheme("nexium");
}

/**
 * The find widget's 16px close button carries a "Close (Escape)" tooltip that
 * Monaco anchors at the cursor, on top of the button itself. The button reads
 * on its own and keeps its aria-label for assistive tech, so the tooltip is
 * dropped: Monaco starts it from a `mouseover` listener on the button, and
 * stopping the event before it reaches that element leaves the CSS `:hover`
 * highlight (findWidget.css) untouched.
 */
function hideFindWidgetCloseTooltip() {
  window.addEventListener(
    "mouseover",
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".find-widget .codicon-widget-close")) {
        event.stopPropagation();
      }
    },
    true,
  );
}

registerInlineCompletions();
hideFindWidgetCloseTooltip();

loader.config({ monaco });

export { monaco };
