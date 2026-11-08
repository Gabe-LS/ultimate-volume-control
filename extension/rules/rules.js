// Saved rules: matching, precedence, validation and storage format. No browser dependency, so it can be tested in Node.

export const SCHEMA_VERSION = 1;
export const MAX_GAIN_DB = 20 * Math.log10(4);
export const REGEX_MAX_LENGTH = 512;
const TIER = { page: 0, regex: 1, site: 2 };

export const CEILING_MIN_DB = -6;
const validCeiling = (v) => typeof v === "number" && v >= CEILING_MIN_DB && v <= 0;
export const defaultStore = () => ({ schemaVersion: SCHEMA_VERSION, rules: [], settings: { ceilingDbtp: 0 }, doNotRoute: [] });

// One function per schema version goes here when a v2 exists.
export function migrate(raw) {
  if (!raw || typeof raw !== "object") return defaultStore();
  const store = { ...defaultStore(), ...raw };
  store.rules = Array.isArray(raw.rules) ? raw.rules.filter(isValidRule) : [];
  store.settings = { ceilingDbtp: validCeiling(raw.settings?.ceilingDbtp) ? raw.settings.ceilingDbtp : defaultStore().settings.ceilingDbtp };
  store.doNotRoute = Array.isArray(raw.doNotRoute) ? raw.doNotRoute.filter((u) => typeof u === "string").reduce(addDoNotRoute, []) : [];
  store.schemaVersion = SCHEMA_VERSION;
  return store;
}

export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

// http and https are separate sites. Match patterns ignore the port, which only matters on a local server.
export function patternFor(origin) {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

// Permissions a deleted rule held that no remaining rule needs. A permission covers every port of a host, so a rule on
// another port still needs it.
export function unusedPatterns(rules, origins) {
  const needed = new Set(rules.flatMap((r) => [...r.origins, ...(r.frameOrigins || [])]).map(patternFor));
  return [...new Set(origins.map(patternFor))].filter((p) => !needed.has(p));
}

// Pages turned off with "Reload without boost", kept by address without the query or fragment, which can carry private
// tokens, and only the most recent ones.
export const DO_NOT_ROUTE_MAX = 200;
export function routeKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return String(url);
  }
}
export function addDoNotRoute(list, url) {
  const key = routeKey(url);
  return [...list.filter((u) => u !== key), key].slice(-DO_NOT_ROUTE_MAX);
}
// Once no rule is left on a site, nothing is kept about its pages.
export function forgetDoNotRoute(store, origins) {
  const gone = origins.filter((o) => !store.rules.some((r) => r.origins.includes(o)));
  store.doNotRoute = store.doNotRoute.filter((u) => !gone.includes(originOf(u)));
}

export function validateRegex(source) {
  if (typeof source !== "string" || !source) return "Enter a pattern";
  if (source.length > REGEX_MAX_LENGTH) return `Longer than ${REGEX_MAX_LENGTH} characters`;
  try {
    new RegExp(source);
    return null;
  } catch (e) {
    return String(e.message || e);
  }
}

export function isValidRule(r) {
  if (!r || typeof r !== "object" || typeof r.id !== "string") return false;
  if (!(r.scope in TIER) || typeof r.pattern !== "string") return false;
  if (!Array.isArray(r.origins) || !r.origins.every((o) => typeof o === "string" && originOf(o) === o)) return false;
  if (r.scope !== "regex" && r.origins.length !== 1) return false;
  if (typeof r.gainDb !== "number" || !(r.gainDb >= 0 && r.gainDb <= MAX_GAIN_DB + 1e-9)) return false;
  if (r.scope === "regex" && validateRegex(r.pattern)) return false;
  if (r.scope === "site" && r.pattern !== r.origins[0]) return false;
  if (r.scope === "page" && originOf(r.pattern) !== r.origins[0]) return false;
  return true;
}

function matches(rule, url) {
  const origin = originOf(url);
  if (!origin || !rule.origins.includes(origin)) return false;
  if (rule.scope === "site") return true;
  if (rule.scope === "page") return rule.pattern === url;
  try {
    return new RegExp(rule.pattern).test(url);
  } catch {
    return false;
  }
}

// Exact page, then regex, then site. Most recently updated wins within a tier.
export function resolve(rules, url) {
  let best = null;
  for (const r of rules) {
    if (!matches(r, url)) continue;
    if (!best || TIER[r.scope] < TIER[best.scope] || (TIER[r.scope] === TIER[best.scope] && r.updatedAt > best.updatedAt)) best = r;
  }
  return best;
}

export function ruleId(scope, pattern) {
  return `${scope}:${pattern}`;
}

// Two rules with one pattern would share an id, and removing one would remove both.
export const regexTaken = (rules, rule, pattern) => rules.some((r) => r !== rule && r.id === ruleId("regex", pattern));

export function makeRule({ scope, origins, pattern, gainDb }, now) {
  return { id: ruleId(scope, pattern), scope, origins, frameOrigins: [], pattern, gainDb, createdAt: now, updatedAt: now };
}

export function makeSiteRule(origin, gainDb, now) {
  return makeRule({ scope: "site", origins: [origin], pattern: origin, gainDb }, now);
}

// What the scope selector means for this URL. A regex comes with its own pattern and origins.
export function targetFor(scope, url, regex) {
  if (scope === "page") return { scope, origins: [originOf(url)], pattern: url };
  if (scope === "regex") return { scope, origins: regex.origins, pattern: regex.pattern };
  return { scope: "site", origins: [originOf(url)], pattern: originOf(url) };
}

export function upsertRule(rules, target, gainDb, now) {
  const existing = rules.find((r) => r.id === ruleId(target.scope, target.pattern));
  if (existing) {
    existing.gainDb = gainDb;
    existing.origins = target.origins;
    existing.updatedAt = now;
    return existing;
  }
  const rule = makeRule({ ...target, gainDb }, now);
  rules.push(rule);
  return rule;
}

// One line per origin, as typed in the regex editor. Returns origins, or throws with what to fix.
export function parseOrigins(text) {
  const origins = [];
  for (const line of String(text).split(/[\s,]+/).filter(Boolean)) {
    const origin = originOf(line);
    if (!origin) throw new Error(`Not a website address: ${line}`);
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (!origins.length) throw new Error("Enter at least one website");
  return origins;
}

// A saved pattern has to do something where the user is standing.
export function validateRegexRule(source, origins, url) {
  const invalid = validateRegex(source);
  if (invalid) return invalid;
  if (!origins.includes(originOf(url))) return "The list of websites must include this one";
  if (!new RegExp(source).test(url)) return "This pattern doesn't match the current page";
  return null;
}

// Rejects anything malformed as a whole, so a bad file cannot half-apply.
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (!data || !Array.isArray(data.rules)) throw new Error("No rules found");
  for (const r of data.rules) if (!isValidRule(r)) throw new Error(`Invalid rule: ${r && r.id}`);
  return migrate(data);
}
