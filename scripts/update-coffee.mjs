#!/usr/bin/env node
/**
 * Refresh the GitHub profile coffee widget from Notion BREWS and SHOTS.
 *
 * Required: NOTION_TOKEN, plus one or both of NOTION_BREWS_DATA_SOURCE_ID
 * and NOTION_SHOTS_DATA_SOURCE_ID (database IDs also work; comma-separated
 * for extra tables). Preview with --demo, --demo-shot, --shot, --brew,
 * COFFEE_KIND=shot|brew, or COFFEE_DEMO=1. Optional: COFFEE_TIMEZONE, NOTION_PROP_DATE,
 * NOTION_PROP_COFFEE, NOTION_PROP_METHOD, NOTION_PROP_DOSE,
 * NOTION_PROP_WATER, NOTION_PROP_YIELD, NOTION_PROP_TEMPERATURE.
 *
 * Cup icons are based on Tabler Icons "coffee" by Paweł Kuna.
 * https://github.com/tabler/tabler-icons
 * MIT License. Copyright (c) 2020-2026 Paweł Kuna.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");
const README = join(ROOT, "README.md");
const NOTION_VERSION = "2026-03-11";
const CARD_WIDTH = 600;
const NAME_MAX_CHARS = 44;
const CARD_HEIGHT = 136;
const WIDGET_START = "<!--START_COFFEE_WIDGET-->";
const WIDGET_END = "<!--END_COFFEE_WIDGET-->";

const THEMES = {
  light: {
    bg: "#ffffff",
    border: "#d0d7de",
    name: "#1f2328",
    muted: "#656d76",
    accent: "#6f4e37",
    icon: "#1f2328",
  },
  dark: {
    bg: "#0d1117",
    border: "#30363d",
    name: "#e6edf3",
    muted: "#8b949e",
    accent: "#e3b77b",
    icon: "#e6edf3",
  },
};

const FIELD_HINTS = {
  date: [/date/i, /brewed/i, /drank/i, /^when\b/i, /timestamp/i],
  coffee: [/coffee/i, /^bean/i],
  method: [/method/i, /^brewer/i, /^device/i],
  dose: [/^dose/i, /coffee dose/i, /^grounds/i, /^in$/i],
  water: [/^water/i],
  yield: [/^yield/i, /^output/i, /^out$/i],
  temperature: [/^temp(?:erature)?\b/i, /celsius/i, /°\s*c/i],
};

const NUMBER_TYPES = new Set(["number", "formula", "rollup", "rich_text"]);
const METHOD_TYPES = new Set(["relation", "select", "rich_text", "title", "rollup"]);
const COFFEE_TYPES = new Set(["relation", "title", "rich_text", "rollup"]);

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

function env(name, fallback = "") {
  return (process.env[name] ?? "").trim() || fallback;
}

function truthy(value) {
  return /^(1|true|yes)$/i.test(value);
}

function requestedKind() {
  if (process.argv.includes("--demo-shot") || process.argv.includes("--shot")) {
    return "shot";
  }
  if (process.argv.includes("--brew")) {
    return "brew";
  }
  const kind = env("COFFEE_KIND").toLowerCase();
  return kind === "shot" || kind === "brew" ? kind : "";
}

function latestOf(cups) {
  return cups.reduce((best, cup) => (!best || cup.sortTime > best.sortTime ? cup : best), null);
}

function parseIds(...names) {
  return names
    .flatMap((name) => env(name).split(/[,\s]+/))
    .map((id) => id.trim())
    .filter(Boolean);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const HARVEST_SUFFIX = /\s*\((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\)\s*$/i;

function displayCoffeeName(value) {
  return value.replace(HARVEST_SUFFIX, "").replace(/\s+/g, " ").trim();
}

function truncate(value, max) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function wrapName(value, maxChars, maxLines = 2) {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) {
      const rest = [current, ...words.slice(i + 1)].join(" ");
      lines.push(truncate(rest, maxChars));
      return lines;
    }
  }

  if (current) {
    lines.push(current.length > maxChars ? truncate(current, maxChars) : current);
  }
  return lines.length > 0 ? lines : [""];
}

function plainText(richText) {
  return (richText ?? []).map((part) => part.plain_text ?? "").join("").trim();
}

function titleFromPage(page) {
  const title = Object.values(page.properties ?? {}).find((prop) => prop.type === "title");
  return title ? plainText(title.title) : "";
}

function numberFrom(prop) {
  if (!prop) {
    return null;
  }
  if (prop.type === "number") {
    return prop.number;
  }
  if (prop.type === "formula" && prop.formula?.type === "number") {
    return prop.formula.number;
  }
  if (prop.type === "rollup" && prop.rollup?.type === "number") {
    return prop.rollup.number;
  }
  if (prop.type === "rich_text") {
    const parsed = Number.parseFloat(plainText(prop.rich_text).replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateFrom(prop, fallbackIso) {
  if (prop?.type === "date" && prop.date?.start) {
    return prop.date.start;
  }
  if (prop?.type === "formula" && prop.formula?.type === "date" && prop.formula.date?.start) {
    return prop.formula.date.start;
  }
  if (prop?.type === "created_time") {
    return prop.created_time;
  }
  return fallbackIso;
}

function dateKey(iso, timeZone) {
  const hasTime = iso.includes("T");
  if (!hasTime) {
    return iso.slice(0, 10);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function formatDate(iso, timeZone) {
  const hasTime = iso.includes("T");
  const date = hasTime ? new Date(iso) : new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: hasTime ? timeZone : "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatQty(value, unit) {
  if (value == null) {
    return null;
  }
  const rounded = Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
  return `${rounded}${unit}`;
}

function formatTemp(value) {
  if (value == null) {
    return null;
  }
  const unit = value > 150 ? "°F" : "°C";
  return formatQty(value, unit);
}

const TYPE_RANK = {
  relation: 0,
  select: 1,
  date: 1,
  number: 1,
  title: 2,
  rich_text: 3,
  formula: 4,
  created_time: 5,
  rollup: 6,
};

function findProperty(schema, hints, types, overrideName) {
  const properties = Object.values(schema.properties ?? {});
  if (overrideName) {
    const match = properties.find((prop) => prop.name === overrideName);
    if (match) {
      return match;
    }
  }
  const typed = (types ? properties.filter((prop) => types.has(prop.type)) : properties).sort(
    (a, b) => (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9)
  );
  for (const hint of hints) {
    const match = typed.find((prop) => hint.test(prop.name));
    if (match) {
      return match;
    }
  }
  return null;
}

function mapSchema(schema) {
  const date =
    findProperty(schema, FIELD_HINTS.date, new Set(["date", "formula"]), env("NOTION_PROP_DATE")) ??
    findProperty(schema, FIELD_HINTS.date, new Set(["created_time"]));
  const coffee = findProperty(
    schema,
    FIELD_HINTS.coffee,
    COFFEE_TYPES,
    env("NOTION_PROP_COFFEE")
  );
  const method = findProperty(
    schema,
    FIELD_HINTS.method,
    METHOD_TYPES,
    env("NOTION_PROP_METHOD")
  );
  const dose = findProperty(schema, FIELD_HINTS.dose, NUMBER_TYPES, env("NOTION_PROP_DOSE"));
  const water = findProperty(schema, FIELD_HINTS.water, NUMBER_TYPES, env("NOTION_PROP_WATER"));
  const yieldAmount = findProperty(
    schema,
    FIELD_HINTS.yield,
    NUMBER_TYPES,
    env("NOTION_PROP_YIELD")
  );
  const temperature = findProperty(
    schema,
    FIELD_HINTS.temperature,
    NUMBER_TYPES,
    env("NOTION_PROP_TEMPERATURE")
  );

  return {
    dataSourceId: schema.id,
    name: schema.name ?? schema.id,
    date,
    coffee,
    method,
    dose,
    water,
    yield: yieldAmount,
    temperature,
  };
}

async function notion(token, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    const detail = payload.message ?? JSON.stringify(payload);
    throw new Error(`Notion ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload;
}

async function resolveDataSourceId(token, id) {
  try {
    const source = await notion(token, `data_sources/${id}`);
    if (source.object === "data_source") {
      return source;
    }
  } catch (error) {
    if (!String(error.message).includes("(404)")) {
      throw error;
    }
  }

  const database = await notion(token, `databases/${id}`);
  const sourceId = database.data_sources?.[0]?.id;
  if (!sourceId) {
    throw new Error(`Database ${id} has no data sources`);
  }
  return notion(token, `data_sources/${sourceId}`);
}

async function latestPage(token, mapping) {
  const sorts = mapping.date
    ? [{ property: mapping.date.name, direction: "descending" }]
    : [{ timestamp: "created_time", direction: "descending" }];
  const result = await notion(token, `data_sources/${mapping.dataSourceId}/query`, {
    method: "POST",
    body: {
      page_size: 1,
      sorts,
    },
  });
  return result.results?.[0] ?? null;
}

async function relatedTitle(token, page, property, cache) {
  if (!property) {
    return "";
  }
  const value = page.properties?.[property.name];
  if (!value) {
    return "";
  }
  if (value.type === "select") {
    return value.select?.name ?? "";
  }
  if (value.type === "title") {
    return plainText(value.title);
  }
  if (value.type === "rich_text") {
    return plainText(value.rich_text);
  }
  if (value.type === "rollup" && value.rollup?.type === "array") {
    const first = value.rollup.array.find((item) => item.type === "title" || item.type === "rich_text");
    if (first?.type === "title") {
      return plainText(first.title);
    }
    if (first?.type === "rich_text") {
      return plainText(first.rich_text);
    }
  }
  if (value.type !== "relation" || !value.relation?.[0]?.id) {
    return "";
  }

  const relatedId = value.relation[0].id;
  if (cache.has(relatedId)) {
    return cache.get(relatedId);
  }
  const related = await notion(token, `pages/${relatedId}`);
  const title = titleFromPage(related);
  cache.set(relatedId, title);
  return title;
}

function toCup(page, mapping, kind, coffeeName, methodName, timeZone) {
  const iso = dateFrom(page.properties?.[mapping.date?.name], page.created_time);
  const dose = numberFrom(page.properties?.[mapping.dose?.name]);
  const liquid =
    kind === "shot"
      ? numberFrom(page.properties?.[mapping.yield?.name])
      : numberFrom(page.properties?.[mapping.water?.name]);
  const temperature = numberFrom(page.properties?.[mapping.temperature?.name]);
  const recipe = [formatQty(dose, "g"), formatQty(liquid, "g"), formatTemp(temperature)].filter(Boolean);

  return {
    kind,
    name: coffeeName || titleFromPage(page) || "Unknown coffee",
    method: methodName || (kind === "shot" ? "Espresso" : ""),
    recipe: recipe.join(" · "),
    dateLabel: formatDate(iso, timeZone),
    day: dateKey(iso, timeZone),
    sortTime: iso.includes("T") ? Date.parse(iso) : Date.parse(`${iso}T00:00:00Z`),
    url: page.url,
  };
}

function chooseCup(brews, shots) {
  const latestBrew = brews.reduce((best, cup) => (!best || cup.sortTime > best.sortTime ? cup : best), null);
  const latestShot = shots.reduce((best, cup) => (!best || cup.sortTime > best.sortTime ? cup : best), null);
  if (!latestBrew) {
    return latestShot;
  }
  if (!latestShot) {
    return latestBrew;
  }
  return latestShot.day >= latestBrew.day ? latestShot : latestBrew;
}

function logMapping(kind, mapping) {
  const fields = ["date", "coffee", "method", "dose", "water", "yield", "temperature"]
    .map((field) => `${field}=${mapping[field]?.name ?? "(none)"}`)
    .join(", ");
  console.log(`[${kind}] ${mapping.name}: ${fields}`);
}

async function loadCups(token, ids, kind, timeZone) {
  const cache = new Map();
  const cups = [];

  for (const id of ids) {
    const schema = await resolveDataSourceId(token, id);
    const mapping = mapSchema(schema);
    logMapping(kind, mapping);
    const page = await latestPage(token, mapping);
    if (!page) {
      continue;
    }
    const coffeeName = await relatedTitle(token, page, mapping.coffee, cache);
    const methodName = await relatedTitle(token, page, mapping.method, cache);
    cups.push(toCup(page, mapping, kind, coffeeName, methodName, timeZone));
  }

  return cups;
}

function tablerCoffeeMarkup(includeHandle) {
  const handle = includeHandle
    ? `<path d="M16.746 16.726a3 3 0 1 0 .252 -5.555" />`
    : "";
  return `
      <path d="M3 14c.83 .642 2.077 1.017 3.5 1c1.423 .017 2.67 -.358 3.5 -1c.83 -.642 2.077 -1.017 3.5 -1c1.423 -.017 2.67 .358 3.5 1" />
      <path d="M8 3a2.4 2.4 0 0 0 -1 2a2.4 2.4 0 0 0 1 2" />
      <path d="M12 3a2.4 2.4 0 0 0 -1 2a2.4 2.4 0 0 0 1 2" />
      <path d="M3 10h14v5a6 6 0 0 1 -6 6h-2a6 6 0 0 1 -6 -6v-5" />
      ${handle}
  `;
}

function cupIconMarkup(theme, kind) {
  return `
    <g fill="none" stroke="${theme.icon}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(18 24) scale(3.5)">
      ${tablerCoffeeMarkup(kind !== "shot")}
    </g>
  `;
}

function renderSvg(cup, themeName) {
  const theme = THEMES[themeName];
  const empty = !cup;
  const kicker = empty ? "Most recent cup" : cup.kind === "shot" ? "Most recent shot" : "Most recent cup";
  const fullName = empty ? "No recent coffee" : displayCoffeeName(cup.name);
  const nameLines = wrapName(fullName, NAME_MAX_CHARS);
  const method = empty ? "" : cup.method;
  const recipe = empty ? "" : cup.recipe;
  const date = empty ? "" : cup.dateLabel;
  const details = [method, recipe].filter(Boolean).join("  ·  ");
  const detailLine = details || (empty ? "Log a brew or shot in Notion" : "");
  const twoLines = nameLines.length > 1;
  const nameSize = twoLines || fullName.length > 28 ? 15 : 18;
  const kickerSize = 12;
  const detailsSize = 13;
  const nameLineHeight = nameSize + 5;
  const kickerToName = 28;
  const nameToDetails = detailLine ? 26 : 0;
  const nameSpan = (nameLines.length - 1) * nameLineHeight;
  const lastBaselineOffset = kickerToName + nameSpan + nameToDetails;
  const visualTopPad = kickerSize * 0.8;
  const visualBottomPad = (detailLine ? detailsSize : nameSize) * 0.2;
  const visualHeight = visualTopPad + lastBaselineOffset + visualBottomPad;
  const kickerY = Math.round((CARD_HEIGHT - visualHeight) / 2 + visualTopPad);
  const nameStartY = kickerY + kickerToName;
  const detailsY = nameStartY + nameSpan + nameToDetails;
  const nameTspans = nameLines
    .map(
      (line, index) =>
        `<tspan x="118" y="${nameStartY + index * nameLineHeight}">${escapeXml(line)}</tspan>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${escapeXml(`${kicker}: ${fullName}`)}">
  <!-- Icon based on Tabler Icons "coffee" by Paweł Kuna. MIT License. https://github.com/tabler/tabler-icons Copyright (c) 2020-2026 Paweł Kuna. -->
  <title>${escapeXml(`${kicker}: ${fullName}`)}</title>
  <rect x="0.75" y="0.75" width="${CARD_WIDTH - 1.5}" height="${CARD_HEIGHT - 1.5}" rx="12" fill="${theme.bg}" stroke="${theme.border}" />
  ${cupIconMarkup(theme, empty ? "brew" : cup.kind)}
  <g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif">
    <text x="118" y="${kickerY}" fill="${theme.muted}" font-size="${kickerSize}">${escapeXml(date ? `${kicker}  ·  ${date}` : kicker)}</text>
    <text fill="${theme.name}" font-size="${nameSize}" font-weight="600">${nameTspans}</text>
    ${detailLine ? `<text x="118" y="${detailsY}" fill="${details ? theme.accent : theme.muted}" font-size="13">${escapeXml(detailLine)}</text>` : ""}
  </g>
</svg>
`;
}

function writeIfChanged(path, contents) {
  if (existsSync(path) && readFileSync(path, "utf8") === contents) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return true;
}

function upsertReadme(cup, bust) {
  const alt = cup
    ? `Most recent ${cup.kind === "shot" ? "shot" : "cup"}: ${displayCoffeeName(cup.name)}, ${cup.method}${cup.recipe ? `, ${cup.recipe}` : ""}, ${cup.dateLabel}`
    : "Most recent coffee";
  const light = `./assets/coffee-light.svg?t=${bust}`;
  const dark = `./assets/coffee-dark.svg?t=${bust}`;
  const block = `${WIDGET_START}
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${dark}" />
  <source media="(prefers-color-scheme: light)" srcset="${light}" />
  <img alt="${escapeXml(alt)}" src="${light}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" />
</picture>
${WIDGET_END}`;

  let readme = existsSync(README) ? readFileSync(README, "utf8") : "";
  if (readme.includes(WIDGET_START) && readme.includes(WIDGET_END)) {
    readme = readme.replace(new RegExp(`${WIDGET_START}[\\s\\S]*?${WIDGET_END}`), block);
  } else {
    readme = `${readme.trimEnd()}\n\n${block}\n`;
  }
  return writeIfChanged(README, readme);
}

function fixtureCup(kind = "brew") {
  if (kind === "shot") {
    return {
      kind: "shot",
      name: "Ethiopia Guji",
      method: "Espresso",
      recipe: "18g · 36g · 93°C",
      dateLabel: "Mar 10, 2026",
      day: "2026-03-10",
      sortTime: Date.parse("2026-03-10T00:00:00Z"),
    };
  }
  return {
    kind: "brew",
    name: "Ethiopia Guji",
    method: "V60",
    recipe: "15g · 250g · 96°C",
    dateLabel: "Mar 10, 2026",
    day: "2026-03-10",
    sortTime: Date.parse("2026-03-10T00:00:00Z"),
  };
}

function selfTest() {
  const brew = { kind: "brew", day: "2026-03-10", sortTime: 2 };
  const shot = { kind: "shot", day: "2026-03-10", sortTime: 1 };
  const laterBrew = { kind: "brew", day: "2026-03-11", sortTime: 3 };
  const checks = [
    [chooseCup([brew], [shot]).kind === "shot", "same-day prefers shot"],
    [chooseCup([laterBrew], [shot]).kind === "brew", "newer brew wins"],
    [chooseCup([brew], []).kind === "brew", "brew only"],
    [chooseCup([], [shot]).kind === "shot", "shot only"],
    [
      displayCoffeeName("Presta Coffee Roasters Ethiopia Honey Koke (Nov 2026)") ===
        "Presta Coffee Roasters Ethiopia Honey Koke",
      "strips trailing month/year",
    ],
    [displayCoffeeName("Ethiopia Guji") === "Ethiopia Guji", "leaves names without a harvest suffix"],
  ];
  for (const [ok, label] of checks) {
    if (!ok) {
      throw new Error(`self-test failed: ${label}`);
    }
  }
  console.log("self-test passed");
}

async function main() {
  loadDotEnv(join(ROOT, ".env"));

  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const kind = requestedKind();
  const demo =
    process.argv.includes("--demo") ||
    process.argv.includes("--demo-shot") ||
    truthy(env("COFFEE_DEMO"));
  const timeZone = env("COFFEE_TIMEZONE", "America/Phoenix");
  let cup = null;

  if (demo) {
    cup = fixtureCup(kind || "brew");
    console.log(`Writing demo ${cup.kind} widget`);
  } else {
    const token = env("NOTION_TOKEN");
    const brewIds = parseIds("NOTION_BREWS_DATA_SOURCE_ID", "NOTION_BREWS_DATA_SOURCE_IDS");
    const shotIds = parseIds("NOTION_SHOTS_DATA_SOURCE_ID", "NOTION_SHOTS_DATA_SOURCE_IDS");

    if (!token) {
      throw new Error("NOTION_TOKEN is required");
    }
    if (brewIds.length === 0 && shotIds.length === 0) {
      throw new Error("Set NOTION_BREWS_DATA_SOURCE_ID and/or NOTION_SHOTS_DATA_SOURCE_ID");
    }

    const [brews, shots] = await Promise.all([
      loadCups(token, brewIds, "brew", timeZone),
      loadCups(token, shotIds, "shot", timeZone),
    ]);
    if (kind === "shot") {
      cup = latestOf(shots);
    } else if (kind === "brew") {
      cup = latestOf(brews);
    } else {
      cup = chooseCup(brews, shots);
    }
    if (cup) {
      console.log(`Using ${cup.kind}: ${cup.name} (${cup.method}) on ${cup.day}`);
    } else {
      console.log(kind ? `No ${kind} rows found` : "No brew or shot rows found");
    }
  }

  const lightChanged = writeIfChanged(join(ASSETS, "coffee-light.svg"), renderSvg(cup, "light"));
  const darkChanged = writeIfChanged(join(ASSETS, "coffee-dark.svg"), renderSvg(cup, "dark"));
  if (lightChanged || darkChanged) {
    upsertReadme(cup, Date.now());
    console.log("Coffee widget updated");
  } else {
    console.log("Coffee widget already up to date");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
