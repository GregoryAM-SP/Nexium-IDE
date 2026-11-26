import { applyEditorTheme } from "./monacoSetup";

export type ThemeScheme = "dark" | "light";

/** Colours for code tokens, independent of the window's ink. */
export type SyntaxPalette = {
  /**
   * This palette has no colour of its own to match a theme, so keywords and
   * tags are drawn in the active theme's accent instead.
   */
  accentFromTheme?: boolean;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  regexp: string;
  type: string;
  variable: string;
  function: string;
  constant: string;
  tag: string;
  attributeName: string;
  attributeValue: string;
  operator: string;
  delimiter: string;
  meta: string;
  invalid: string;
};

export type Theme = {
  id: string;
  name: string;
  scheme: ThemeScheme;
  /** Page colour. */
  bg: string;
  /** Text and hairlines are mixed from this. */
  fg: string;
  /** Selections, the caret and focus rings. */
  accent: string;
  /** Code token colours. */
  syntax: SyntaxPalette;
};

const darkClassic: SyntaxPalette = {
  accentFromTheme: true,
  comment: "#6A9955",
  keyword: "#C586C0",
  string: "#CE9178",
  number: "#B5CEA8",
  regexp: "#D16969",
  type: "#4EC9B0",
  variable: "#9CDCFE",
  function: "#DCDCAA",
  constant: "#4FC1FF",
  tag: "#569CD6",
  attributeName: "#9CDCFE",
  attributeValue: "#CE9178",
  operator: "#D4D4D4",
  delimiter: "#8A8A8A",
  meta: "#569CD6",
  invalid: "#F44747",
};

const lightClassic: SyntaxPalette = {
  accentFromTheme: true,
  comment: "#008000",
  keyword: "#AF00DB",
  string: "#A31515",
  number: "#098658",
  regexp: "#811F3F",
  type: "#267F99",
  variable: "#001080",
  function: "#795E26",
  constant: "#0070C1",
  tag: "#800000",
  attributeName: "#E50000",
  attributeValue: "#0451A5",
  operator: "#333333",
  delimiter: "#767676",
  meta: "#800000",
  invalid: "#CD3131",
};

const dracula: SyntaxPalette = {
  comment: "#6272A4",
  keyword: "#FF79C6",
  string: "#F1FA8C",
  number: "#BD93F9",
  regexp: "#FF5555",
  type: "#8BE9FD",
  variable: "#F8F8F2",
  function: "#50FA7B",
  constant: "#BD93F9",
  tag: "#FF79C6",
  attributeName: "#50FA7B",
  attributeValue: "#F1FA8C",
  operator: "#FF79C6",
  delimiter: "#F8F8F2",
  meta: "#8BE9FD",
  invalid: "#FF5555",
};

const nord: SyntaxPalette = {
  comment: "#616E88",
  keyword: "#81A1C1",
  string: "#A3BE8C",
  number: "#B48EAD",
  regexp: "#EBCB8B",
  type: "#8FBCBB",
  variable: "#D8DEE9",
  function: "#88C0D0",
  constant: "#B48EAD",
  tag: "#81A1C1",
  attributeName: "#8FBCBB",
  attributeValue: "#A3BE8C",
  operator: "#81A1C1",
  delimiter: "#D8DEE9",
  meta: "#5E81AC",
  invalid: "#BF616A",
};

const gruvbox: SyntaxPalette = {
  comment: "#928374",
  keyword: "#FB4934",
  string: "#B8BB26",
  number: "#D3869B",
  regexp: "#FE8019",
  type: "#FABD2F",
  variable: "#83A598",
  function: "#8EC07C",
  constant: "#D3869B",
  tag: "#FABD2F",
  attributeName: "#83A598",
  attributeValue: "#B8BB26",
  operator: "#FE8019",
  delimiter: "#EBDBB2",
  meta: "#FE8019",
  invalid: "#FB4934",
};

const solarized: SyntaxPalette = {
  comment: "#586E75",
  keyword: "#859900",
  string: "#2AA198",
  number: "#D33682",
  regexp: "#DC322F",
  type: "#B58900",
  variable: "#268BD2",
  function: "#268BD2",
  constant: "#CB4B16",
  tag: "#268BD2",
  attributeName: "#93A1A1",
  attributeValue: "#2AA198",
  operator: "#859900",
  delimiter: "#839496",
  meta: "#CB4B16",
  invalid: "#DC322F",
};

const tokyo: SyntaxPalette = {
  comment: "#565F89",
  keyword: "#BB9AF7",
  string: "#9ECE6A",
  number: "#FF9E64",
  regexp: "#FF7A93",
  type: "#2AC3DE",
  variable: "#C0CAF5",
  function: "#7AA2F7",
  constant: "#FF9E64",
  tag: "#F7768E",
  attributeName: "#7AA2F7",
  attributeValue: "#9ECE6A",
  operator: "#89DDFF",
  delimiter: "#A9B1D6",
  meta: "#F7768E",
  invalid: "#DB4B4B",
};

const monokai: SyntaxPalette = {
  comment: "#75715E",
  keyword: "#F92672",
  string: "#E6DB74",
  number: "#AE81FF",
  regexp: "#E6DB74",
  type: "#66D9EF",
  variable: "#FD971F",
  function: "#A6E22E",
  constant: "#AE81FF",
  tag: "#F92672",
  attributeName: "#A6E22E",
  attributeValue: "#E6DB74",
  operator: "#F92672",
  delimiter: "#F8F8F2",
  meta: "#F92672",
  invalid: "#F92672",
};

const catppuccin: SyntaxPalette = {
  comment: "#6C7086",
  keyword: "#CBA6F7",
  string: "#A6E3A1",
  number: "#FAB387",
  regexp: "#F38BA8",
  type: "#89DCEB",
  variable: "#CDD6F4",
  function: "#89B4FA",
  constant: "#FAB387",
  tag: "#CBA6F7",
  attributeName: "#89B4FA",
  attributeValue: "#A6E3A1",
  operator: "#89DDFF",
  delimiter: "#9399B2",
  meta: "#F5C2E7",
  invalid: "#F38BA8",
};

const rosePine: SyntaxPalette = {
  comment: "#6E6A86",
  keyword: "#C4A7E7",
  string: "#F6C177",
  number: "#EBBCBA",
  regexp: "#EB6F92",
  type: "#9CCFD8",
  variable: "#E0DEF4",
  function: "#EBBCBA",
  constant: "#EBBCBA",
  tag: "#C4A7E7",
  attributeName: "#9CCFD8",
  attributeValue: "#F6C177",
  operator: "#C4A7E7",
  delimiter: "#E0DEF4",
  meta: "#EB6F92",
  invalid: "#EB6F92",
};

const oneDark: SyntaxPalette = {
  comment: "#5C6370",
  keyword: "#C678DD",
  string: "#98C379",
  number: "#D19A66",
  regexp: "#56B6C2",
  type: "#E5C07B",
  variable: "#E06C75",
  function: "#61AFEF",
  constant: "#D19A66",
  tag: "#E06C75",
  attributeName: "#D19A66",
  attributeValue: "#98C379",
  operator: "#56B6C2",
  delimiter: "#ABB2BF",
  meta: "#56B6C2",
  invalid: "#E06C75",
};

const githubDark: SyntaxPalette = {
  comment: "#8B949E",
  keyword: "#FF7B72",
  string: "#A5D6FF",
  number: "#79C0FF",
  regexp: "#A5D6FF",
  type: "#FFA657",
  variable: "#C9D1D9",
  function: "#D2A8FF",
  constant: "#79C0FF",
  tag: "#7EE787",
  attributeName: "#79C0FF",
  attributeValue: "#A5D6FF",
  operator: "#FF7B72",
  delimiter: "#C9D1D9",
  meta: "#D2A8FF",
  invalid: "#FFA198",
};

const githubLight: SyntaxPalette = {
  comment: "#6E7781",
  keyword: "#CF222E",
  string: "#0A3069",
  number: "#0550AE",
  regexp: "#0A3069",
  type: "#953800",
  variable: "#1F2328",
  function: "#8250DF",
  constant: "#0550AE",
  tag: "#116329",
  attributeName: "#0550AE",
  attributeValue: "#0A3069",
  operator: "#CF222E",
  delimiter: "#1F2328",
  meta: "#8250DF",
  invalid: "#CF222E",
};

const nightOwl: SyntaxPalette = {
  comment: "#637777",
  keyword: "#C792EA",
  string: "#ECC48D",
  number: "#F78C6C",
  regexp: "#5CA7E4",
  type: "#FFCB8B",
  variable: "#D6DEEB",
  function: "#82AAFF",
  constant: "#82AAFF",
  tag: "#7FDBCA",
  attributeName: "#ADDB67",
  attributeValue: "#ECC48D",
  operator: "#7FDBCA",
  delimiter: "#D6DEEB",
  meta: "#82AAFF",
  invalid: "#EF5350",
};

const kanagawa: SyntaxPalette = {
  comment: "#727169",
  keyword: "#957FB8",
  string: "#98BB6C",
  number: "#D27E99",
  regexp: "#E46876",
  type: "#7FB4CA",
  variable: "#DCD7BA",
  function: "#7E9CD8",
  constant: "#FFA066",
  tag: "#E46876",
  attributeName: "#7FB4CA",
  attributeValue: "#98BB6C",
  operator: "#C0A36E",
  delimiter: "#DCD7BA",
  meta: "#7FB4CA",
  invalid: "#E82424",
};

const everforest: SyntaxPalette = {
  comment: "#7A8478",
  keyword: "#E67E80",
  string: "#A7C080",
  number: "#D699B6",
  regexp: "#E67E80",
  type: "#DBBC7F",
  variable: "#D3C6AA",
  function: "#A7C080",
  constant: "#D699B6",
  tag: "#E67E80",
  attributeName: "#7FBBB3",
  attributeValue: "#A7C080",
  operator: "#E69875",
  delimiter: "#D3C6AA",
  meta: "#DBBC7F",
  invalid: "#E67E80",
};

const cobalt2: SyntaxPalette = {
  comment: "#0088FF",
  keyword: "#FF9D00",
  string: "#A5FF90",
  number: "#FF628C",
  regexp: "#80FCFF",
  type: "#9EFFFF",
  variable: "#9EFFFF",
  function: "#FFC600",
  constant: "#FF628C",
  tag: "#9EFFFF",
  attributeName: "#FFC600",
  attributeValue: "#A5FF90",
  operator: "#FF9D00",
  delimiter: "#FFFFFF",
  meta: "#FFC600",
  invalid: "#FF628C",
};

const zenburn: SyntaxPalette = {
  comment: "#7F9F7F",
  keyword: "#F0DFAF",
  string: "#CC9393",
  number: "#8CD0D3",
  regexp: "#CC9393",
  type: "#DFDFBF",
  variable: "#DCDCCC",
  function: "#EFEF8F",
  constant: "#DCA3A3",
  tag: "#F0DFAF",
  attributeName: "#DFDFBF",
  attributeValue: "#CC9393",
  operator: "#F0EFD0",
  delimiter: "#DCDCCC",
  meta: "#DFAF8F",
  invalid: "#CC9393",
};

export const THEMES: Theme[] = [
  {
    id: "nexium",
    name: "Nexium",
    scheme: "dark",
    bg: "#000000",
    fg: "#ffffff",
    accent: "#ffffff",
    syntax: darkClassic,
  },
  {
    id: "graphite",
    name: "Graphite",
    scheme: "dark",
    bg: "#151618",
    fg: "#e9e9ec",
    accent: "#c7c9d1",
    syntax: darkClassic,
  },
  {
    id: "light",
    name: "Daylight",
    scheme: "light",
    bg: "#ffffff",
    fg: "#151515",
    accent: "#3d3d3d",
    syntax: lightClassic,
  },
  {
    id: "paper",
    name: "Paper",
    scheme: "light",
    bg: "#f7f3e9",
    fg: "#2b2418",
    accent: "#8a6a3b",
    syntax: lightClassic,
  },
  {
    id: "glacier",
    name: "Glacier",
    scheme: "light",
    bg: "#eef2f8",
    fg: "#182432",
    accent: "#2f6fed",
    syntax: lightClassic,
  },
  {
    id: "dracula",
    name: "Dracula",
    scheme: "dark",
    bg: "#282a36",
    fg: "#f8f8f2",
    accent: "#bd93f9",
    syntax: dracula,
  },
  {
    id: "nord",
    name: "Nord",
    scheme: "dark",
    bg: "#2e3440",
    fg: "#eceff4",
    accent: "#88c0d0",
    syntax: nord,
  },
  {
    id: "forest",
    name: "Forest",
    scheme: "dark",
    bg: "#0f1a14",
    fg: "#d7e8dc",
    accent: "#6fd39a",
    syntax: darkClassic,
  },
  {
    id: "ocean",
    name: "Ocean",
    scheme: "dark",
    bg: "#0a1622",
    fg: "#d6e7f5",
    accent: "#5eb3e6",
    syntax: darkClassic,
  },
  {
    id: "sunset",
    name: "Sunset",
    scheme: "dark",
    bg: "#1c1214",
    fg: "#f7e4da",
    accent: "#ff9f6e",
    syntax: darkClassic,
  },
  {
    id: "rose",
    name: "Rosé Pine",
    scheme: "dark",
    bg: "#191724",
    fg: "#e0def4",
    accent: "#ebbcba",
    syntax: rosePine,
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    scheme: "dark",
    bg: "#282828",
    fg: "#ebdbb2",
    accent: "#fabd2f",
    syntax: gruvbox,
  },
  {
    id: "solarized",
    name: "Solarized",
    scheme: "dark",
    bg: "#002b36",
    fg: "#93a1a1",
    accent: "#b58900",
    syntax: solarized,
  },
  {
    id: "tokyo",
    name: "Tokyo Night",
    scheme: "dark",
    bg: "#1a1b26",
    fg: "#c0caf5",
    accent: "#7aa2f7",
    syntax: tokyo,
  },
  {
    id: "monokai",
    name: "Monokai",
    scheme: "dark",
    bg: "#272822",
    fg: "#f8f8f2",
    accent: "#a6e22e",
    syntax: monokai,
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    scheme: "dark",
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    accent: "#cba6f7",
    syntax: catppuccin,
  },
  {
    id: "onedark",
    name: "One Dark",
    scheme: "dark",
    bg: "#282c34",
    fg: "#abb2bf",
    accent: "#61afef",
    syntax: oneDark,
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    scheme: "dark",
    bg: "#0d1117",
    fg: "#c9d1d9",
    accent: "#58a6ff",
    syntax: githubDark,
  },
  {
    id: "github-light",
    name: "GitHub Light",
    scheme: "light",
    bg: "#ffffff",
    fg: "#1f2328",
    accent: "#0969da",
    syntax: githubLight,
  },
  {
    id: "night-owl",
    name: "Night Owl",
    scheme: "dark",
    bg: "#011627",
    fg: "#d6deeb",
    accent: "#82aaff",
    syntax: nightOwl,
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    scheme: "dark",
    bg: "#1f1f28",
    fg: "#dcd7ba",
    accent: "#7e9cd8",
    syntax: kanagawa,
  },
  {
    id: "everforest",
    name: "Everforest",
    scheme: "dark",
    bg: "#2b3339",
    fg: "#d3c6aa",
    accent: "#a7c080",
    syntax: everforest,
  },
  {
    id: "cobalt2",
    name: "Cobalt2",
    scheme: "dark",
    bg: "#193549",
    fg: "#ffffff",
    accent: "#ffc600",
    syntax: cobalt2,
  },
  {
    id: "zenburn",
    name: "Zenburn",
    scheme: "dark",
    bg: "#3f3f3f",
    fg: "#dcdccc",
    accent: "#f0dfaf",
    syntax: zenburn,
  },
];

export const defaultThemeId = "nexium";

const STORAGE_KEY = "nexium-theme";

export function themeById(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function loadThemeId(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);

    return stored && THEMES.some((theme) => theme.id === stored)
      ? stored
      : defaultThemeId;
  } catch {
    return defaultThemeId;
  }
}

export function saveThemeId(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A blocked storage backend just means the choice lasts this session.
  }
}

/** Paints the whole window, including Monaco, with one theme. */
export function applyTheme(id: string) {
  const theme = themeById(id);
  const root = document.documentElement;

  root.style.setProperty("--nx-bg", theme.bg);
  root.style.setProperty("--nx-fg", theme.fg);
  root.style.setProperty("--nx-accent", theme.accent);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;

  applyEditorTheme(theme);
}
