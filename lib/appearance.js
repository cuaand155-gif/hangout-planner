export const APPEARANCES = [
  { id: "auto", name: "Auto", icon: "i-contrast" },
  { id: "light", name: "Light", icon: "i-sun" },
  { id: "dark", name: "Dark", icon: "i-moon" },
];

export const DEFAULT_APPEARANCE = "auto";

/** Browser chrome colour (<meta name="theme-color">) for each resolved theme; matches --bg. */
export const THEME_COLORS = { light: "#f4eee6", dark: "#16120f" };

export function normalizeAppearance(id) {
  return APPEARANCES.some((appearance) => appearance.id === id) ? id : DEFAULT_APPEARANCE;
}

/** The theme to paint: Auto follows the system setting, Light and Dark force it. */
export function resolveTheme(appearance, systemPrefersDark) {
  const mode = normalizeAppearance(appearance);
  if (mode === "auto") return systemPrefersDark ? "dark" : "light";
  return mode;
}
