// Draws the static fallback preview card, icons/og-card.png, with the same
// renderer as /api/og (used when that can't draw, and for links without an
// invite code). Run after changing the card: node scripts/make-og-card.mjs

import { writeFile } from "node:fs/promises";
import { renderCard } from "../api/og.js";
import { GENERIC_PREVIEW } from "../api/_preview.js";

const png = await renderCard(GENERIC_PREVIEW);
await writeFile(new URL("../icons/og-card.png", import.meta.url), png);
console.log(`icons/og-card.png: ${png.length} bytes`);
