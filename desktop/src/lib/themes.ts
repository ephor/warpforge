/**
 * Color themes. Warpforge surfaces are styled entirely through a fixed set of
 * hue-saturation-lightness triplets exposed as CSS variables (hsl(var(--x))),
 * so a theme is just a lookup of nested names → hsl triplet. Applying one is a
 * single inline-style write on the document root — same mechanism as font
 * scaling, but for color instead of size.
 *
 * The `forge` theme is the default and matches the values hard-coded in
 * globals.css `:root`; the others add light variants and off-neutral palettes.
 */

export interface ThemeColors {
  background: string;
  foreground: string;
  card: string;
  "card-foreground": string;
  popover: string;
  "popover-foreground": string;
  primary: string;
  "primary-foreground": string;
  secondary: string;
  "secondary-foreground": string;
  muted: string;
  "muted-foreground": string;
  accent: string;
  "accent-foreground": string;
  destructive: string;
  "destructive-foreground": string;
  border: string;
  input: string;
  ring: string;
  ok: string;
  warn: string;
  info: string;
  /** The innermost nested surface (inputs, embedded editors). */
  "deep-surface": string;
  // Syntax highlighting tokens for CodeMirror. Kept alongside the palette so
  // editor colors track the theme instead of CodeMirror's built-in defaults.
  "syntax-keyword": string;
  "syntax-string": string;
  "syntax-const": string;
  "syntax-comment": string;
  "syntax-function": string;
  "syntax-type": string;
  "syntax-variable": string;
  "syntax-operator": string;
  "syntax-punctuation": string;
  "syntax-tag": string;
  "syntax-attribute": string;
}

export interface Theme {
  id: string;
  name: string;
  /** Whether the theme is light or dark. Drives the `.dark` toggle + OS chrome. */
  mode: "light" | "dark";
  colors: ThemeColors;
}

export const THEMES: Theme[] = [
  {
    id: "forge",
    name: "Forge",
    mode: "dark",
    colors: {
      background: "120 3% 8%",
      foreground: "36 23% 91%",
      card: "120 3% 6%",
      "card-foreground": "36 20% 89%",
      popover: "120 3% 9%",
      "popover-foreground": "36 20% 89%",
      primary: "20 73% 70%",
      "primary-foreground": "20 40% 10%",
      secondary: "75 5% 15%",
      "secondary-foreground": "36 20% 89%",
      muted: "90 3% 11%",
      "muted-foreground": "34 7% 62%",
      accent: "72 5% 20%",
      "accent-foreground": "36 25% 94%",
      destructive: "352 73% 74%",
      "destructive-foreground": "352 40% 12%",
      border: "72 5% 20%",
      input: "52 6% 27%",
      ring: "20 73% 70%",
      ok: "137 47% 67%",
      warn: "39 72% 67%",
      info: "172 48% 63%",
      "deep-surface": "120 4% 4%",
      "syntax-keyword": "20 73% 70%",
      "syntax-string": "75 40% 60%",
      "syntax-const": "172 50% 65%",
      "syntax-comment": "34 10% 55%",
      "syntax-function": "137 40% 70%",
      "syntax-type": "46 55% 70%",
      "syntax-variable": "200 30% 72%",
      "syntax-operator": "30 25% 68%",
      "syntax-punctuation": "36 10% 60%",
      "syntax-tag": "20 65% 72%",
      "syntax-attribute": "150 45% 72%",
    },
  },
  {
    id: "paper",
    name: "Paper",
    mode: "light",
    colors: {
      background: "40 8% 97%",
      foreground: "30 15% 18%",
      card: "45 10% 99%",
      "card-foreground": "30 15% 20%",
      popover: "40 8% 97%",
      "popover-foreground": "30 15% 20%",
      primary: "22 45% 46%",
      "primary-foreground": "40 40% 98%",
      secondary: "40 8% 91%",
      "secondary-foreground": "30 15% 24%",
      muted: "42 8% 91%",
      "muted-foreground": "30 7% 47%",
      accent: "40 9% 89%",
      "accent-foreground": "30 15% 16%",
      destructive: "0 55% 50%",
      "destructive-foreground": "0 0% 100%",
      border: "40 8% 84%",
      input: "40 9% 72%",
      ring: "22 45% 46%",
      ok: "137 45% 38%",
      warn: "39 70% 45%",
      info: "172 45% 38%",
      "deep-surface": "40 18% 92%",
      "syntax-keyword": "20 60% 38%",
      "syntax-string": "95 45% 32%",
      "syntax-const": "172 50% 32%",
      "syntax-comment": "30 10% 48%",
      "syntax-function": "137 40% 30%",
      "syntax-type": "45 60% 38%",
      "syntax-variable": "215 40% 40%",
      "syntax-operator": "30 40% 35%",
      "syntax-punctuation": "30 15% 45%",
      "syntax-tag": "20 55% 40%",
      "syntax-attribute": "150 40% 34%",
    },
  },
  {
    id: "oldmoney",
    name: "Old Money",
    mode: "dark",
    colors: {
      background: "150 15% 8%",
      foreground: "40 25% 90%",
      card: "150 13% 6%",
      "card-foreground": "40 20% 88%",
      popover: "150 14% 9%",
      "popover-foreground": "40 20% 88%",
      primary: "40 45% 58%",
      "primary-foreground": "40 30% 12%",
      secondary: "150 12% 15%",
      "secondary-foreground": "40 20% 88%",
      muted: "150 11% 12%",
      "muted-foreground": "40 10% 60%",
      accent: "25 24% 21%",
      "accent-foreground": "40 30% 92%",
      destructive: "0 52% 62%",
      "destructive-foreground": "0 40% 12%",
      border: "150 11% 20%",
      input: "40 14% 28%",
      ring: "40 45% 58%",
      ok: "130 40% 55%",
      warn: "45 70% 60%",
      info: "185 40% 55%",
      "deep-surface": "150 18% 4%",
      "syntax-keyword": "40 55% 60%",
      "syntax-string": "45 40% 62%",
      "syntax-const": "185 40% 55%",
      "syntax-comment": "40 15% 55%",
      "syntax-function": "150 40% 60%",
      "syntax-type": "20 40% 65%",
      "syntax-variable": "160 30% 65%",
      "syntax-operator": "40 35% 68%",
      "syntax-punctuation": "40 15% 62%",
      "syntax-tag": "35 50% 68%",
      "syntax-attribute": "130 40% 60%",
    },
  },
  {
    id: "ivory",
    name: "Ivory",
    mode: "light",
    colors: {
      background: "42 12% 96%",
      foreground: "150 20% 16%",
      card: "42 12% 98%",
      "card-foreground": "150 20% 18%",
      popover: "42 10% 96%",
      "popover-foreground": "150 20% 18%",
      primary: "38 36% 46%",
      "primary-foreground": "40 40% 97%",
      secondary: "45 10% 91%",
      "secondary-foreground": "150 18% 22%",
      muted: "45 9% 91%",
      "muted-foreground": "40 11% 46%",
      accent: "20 16% 90%",
      "accent-foreground": "150 18% 15%",
      destructive: "0 52% 48%",
      "destructive-foreground": "0 0% 100%",
      border: "42 11% 84%",
      input: "42 12% 72%",
      ring: "38 36% 46%",
      ok: "130 40% 36%",
      warn: "45 65% 45%",
      info: "185 40% 36%",
      "deep-surface": "45 28% 90%",
      "syntax-keyword": "38 50% 38%",
      "syntax-string": "95 40% 32%",
      "syntax-const": "185 45% 30%",
      "syntax-comment": "40 15% 45%",
      "syntax-function": "150 35% 30%",
      "syntax-type": "20 40% 40%",
      "syntax-variable": "210 35% 40%",
      "syntax-operator": "38 50% 34%",
      "syntax-punctuation": "40 20% 42%",
      "syntax-tag": "35 45% 40%",
      "syntax-attribute": "130 38% 32%",
    },
  },
  {
    id: "forest",
    name: "Forest",
    mode: "dark",
    colors: {
      background: "150 30% 8%",
      foreground: "60 12% 88%",
      card: "150 28% 6%",
      "card-foreground": "60 10% 86%",
      popover: "150 30% 9%",
      "popover-foreground": "60 10% 86%",
      primary: "140 45% 55%",
      "primary-foreground": "140 30% 10%",
      secondary: "150 20% 16%",
      "secondary-foreground": "60 10% 86%",
      muted: "150 18% 12%",
      "muted-foreground": "60 8% 55%",
      accent: "90 30% 18%",
      "accent-foreground": "60 20% 92%",
      destructive: "0 55% 64%",
      "destructive-foreground": "0 40% 12%",
      border: "150 18% 20%",
      input: "60 14% 30%",
      ring: "140 45% 55%",
      ok: "110 40% 55%",
      warn: "45 70% 60%",
      info: "175 45% 55%",
      "deep-surface": "150 30% 5%",
      "syntax-keyword": "140 50% 60%",
      "syntax-string": "65 40% 55%",
      "syntax-const": "175 45% 60%",
      "syntax-comment": "60 10% 50%",
      "syntax-function": "100 40% 65%",
      "syntax-type": "90 50% 70%",
      "syntax-variable": "160 30% 68%",
      "syntax-operator": "60 25% 65%",
      "syntax-punctuation": "60 12% 58%",
      "syntax-tag": "120 45% 66%",
      "syntax-attribute": "130 45% 62%",
    },
  },
  {
    id: "moss",
    name: "Moss",
    mode: "light",
    colors: {
      background: "90 11% 96%",
      foreground: "150 25% 16%",
      card: "90 12% 98%",
      "card-foreground": "150 22% 18%",
      popover: "90 10% 96%",
      "popover-foreground": "150 22% 18%",
      primary: "130 38% 38%",
      "primary-foreground": "80 30% 97%",
      secondary: "95 10% 91%",
      "secondary-foreground": "150 22% 22%",
      muted: "95 9% 91%",
      "muted-foreground": "150 14% 45%",
      accent: "90 10% 90%",
      "accent-foreground": "150 20% 14%",
      destructive: "0 52% 48%",
      "destructive-foreground": "0 0% 100%",
      border: "95 10% 84%",
      input: "95 10% 73%",
      ring: "130 38% 38%",
      ok: "120 40% 36%",
      warn: "45 65% 46%",
      info: "175 45% 38%",
      "deep-surface": "95 18% 92%",
      "syntax-keyword": "130 45% 32%",
      "syntax-string": "110 40% 30%",
      "syntax-const": "175 45% 32%",
      "syntax-comment": "150 15% 44%",
      "syntax-function": "120 40% 30%",
      "syntax-type": "90 45% 34%",
      "syntax-variable": "160 30% 38%",
      "syntax-operator": "130 40% 32%",
      "syntax-punctuation": "150 18% 42%",
      "syntax-tag": "120 40% 34%",
      "syntax-attribute": "130 40% 32%",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    mode: "dark",
    colors: {
      background: "220 25% 8%",
      foreground: "210 20% 88%",
      card: "220 22% 6%",
      "card-foreground": "210 16% 86%",
      popover: "220 25% 9%",
      "popover-foreground": "210 16% 86%",
      primary: "210 70% 65%",
      "primary-foreground": "220 45% 10%",
      secondary: "220 18% 15%",
      "secondary-foreground": "210 16% 86%",
      muted: "220 18% 11%",
      "muted-foreground": "215 12% 55%",
      accent: "230 22% 20%",
      "accent-foreground": "210 25% 92%",
      destructive: "0 55% 64%",
      "destructive-foreground": "0 40% 12%",
      border: "220 18% 20%",
      input: "220 15% 30%",
      ring: "210 70% 65%",
      ok: "150 40% 55%",
      warn: "45 70% 60%",
      info: "200 45% 55%",
      "deep-surface": "225 24% 5%",
      "syntax-keyword": "210 70% 68%",
      "syntax-string": "160 45% 58%",
      "syntax-const": "180 45% 60%",
      "syntax-comment": "215 12% 50%",
      "syntax-function": "140 40% 66%",
      "syntax-type": "230 50% 74%",
      "syntax-variable": "200 35% 70%",
      "syntax-operator": "220 30% 68%",
      "syntax-punctuation": "210 15% 58%",
      "syntax-tag": "200 55% 70%",
      "syntax-attribute": "190 45% 64%",
    },
  },
  {
    id: "sky",
    name: "Sky",
    mode: "light",
    colors: {
      background: "210 13% 96%",
      foreground: "220 40% 16%",
      card: "210 13% 98%",
      "card-foreground": "220 35% 18%",
      popover: "210 11% 96%",
      "popover-foreground": "220 35% 18%",
      primary: "210 58% 42%",
      "primary-foreground": "210 40% 97%",
      secondary: "212 13% 91%",
      "secondary-foreground": "220 35% 22%",
      muted: "212 11% 91%",
      "muted-foreground": "220 24% 45%",
      accent: "225 13% 90%",
      "accent-foreground": "220 30% 14%",
      destructive: "0 52% 48%",
      "destructive-foreground": "0 0% 100%",
      border: "215 12% 84%",
      input: "215 13% 73%",
      ring: "210 58% 42%",
      ok: "150 45% 38%",
      warn: "45 65% 46%",
      info: "190 45% 38%",
      "deep-surface": "215 28% 92%",
      "syntax-keyword": "210 60% 36%",
      "syntax-string": "180 45% 34%",
      "syntax-const": "190 45% 34%",
      "syntax-comment": "220 25% 44%",
      "syntax-function": "150 45% 32%",
      "syntax-type": "230 55% 40%",
      "syntax-variable": "215 45% 42%",
      "syntax-operator": "220 45% 36%",
      "syntax-punctuation": "220 20% 44%",
      "syntax-tag": "200 55% 40%",
      "syntax-attribute": "190 45% 36%",
    },
  },
];

export const DEFAULT_THEME = "forge";

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
