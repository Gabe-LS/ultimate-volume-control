import { MAX_GAIN_DB, parseOrigins, patternFor, ruleId, validateRegex } from "../rules/rules.js";

const $ = (id) => document.getElementById(id);
const ALL_SITES = "*://*/*";
const toDb = (percent) => 20 * Math.log10(percent / 100);
const toPercent = (db) => Math.round(100 * Math.pow(10, db / 20));
const MAX_PERCENT = toPercent(MAX_GAIN_DB);
const KIND = { site: "Site", page: "Page", regex: "Pages matching a pattern" };
const send = (m) => chrome.runtime.sendMessage(m);
const say = (text) => { $("message").textContent = text; };

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

function row(rule) {
  const volume = el("input", { type: "number", min: 100, max: MAX_PERCENT, step: 1, value: toPercent(rule.gainDb) });
  volume.setAttribute("aria-label", `Volume for ${rule.pattern}, percent`);
  volume.addEventListener("change", async () => {
    const percent = Number(volume.value);
    if (!(percent >= 100 && percent <= MAX_PERCENT)) {
      volume.value = toPercent(rule.gainDb);
      return say(`Enter a volume from 100% to ${MAX_PERCENT}%.`);
    }
    const r = await send({ type: "rule-save", id: rule.id, gainDb: toDb(percent) });
    say(r?.ok ? `Saved ${rule.pattern} at ${percent}%.` : r?.error || "Not saved.");
    render();
  });

  const target = el("td", {}, [el("span", { className: "kind", textContent: KIND[rule.scope] })]);
  if (rule.scope === "regex") {
    const pattern = el("input", { type: "text", value: rule.pattern, spellcheck: false });
    const origins = el("textarea", { rows: 2, value: rule.origins.join("\n"), spellcheck: false });
    const save = el("button", { type: "button", textContent: "Save pattern" });
    save.addEventListener("click", () => {
      const invalid = validateRegex(pattern.value.trim());
      if (invalid) return say(invalid);
      let list;
      try {
        list = parseOrigins(origins.value);
      } catch (e) {
        return say(e.message);
      }
      // First in the handler: the click is what lets Chrome show its prompt.
      chrome.permissions.request({ origins: list.map(patternFor) }).then(async (granted) => {
        if (!granted) return say("Not saved. These websites need access first.");
        const r = await send({ type: "rule-save", id: rule.id, pattern: pattern.value.trim(), origins: list });
        say(r?.ok ? "Pattern saved." : r?.error || "Not saved.");
        if (r?.ok) save.closest("tr").dataset.ruleId = ruleId("regex", pattern.value.trim()); // Its id follows the pattern.
        render();
      });
    });
    target.append(el("div", { className: "pattern" }, [
      el("label", { textContent: "Pattern (regular expression)" }, [pattern]),
      el("label", { textContent: "Websites it applies on, one per line" }, [origins]),
      el("div", {}, [save]),
    ]));
  } else {
    target.append(el("span", { className: "target", textContent: rule.pattern }));
  }
  const actions = el("td");
  if (rule.permissionNeeded) {
    target.append(el("span", { className: "needs", textContent: "Permission needed" }));
    const grant = el("button", { type: "button", textContent: "Allow" });
    grant.setAttribute("aria-label", `Allow ${rule.pattern}`);
    grant.addEventListener("click", () => {
      chrome.permissions.request({ origins: rule.origins.map(patternFor) }).then((granted) => {
        say(granted ? `Allowed ${rule.pattern}.` : `${rule.pattern} still has no access, so it stays at 100%.`);
        render();
      });
    });
    actions.append(grant);
  }
  const remove = el("button", { type: "button", textContent: "Remove" });
  remove.setAttribute("aria-label", `Remove ${rule.pattern}`);
  remove.addEventListener("click", async () => {
    await send({ type: "rule-delete", id: rule.id });
    say(`Removed ${rule.pattern}.`);
    render();
  });
  actions.append(remove);
  const tr = el("tr", {}, [target, el("td", {}, [el("div", { className: "volume" }, [volume, "%"])]), actions]);
  tr.dataset.ruleId = rule.id;
  return tr;
}

async function render() {
  const store = await send({ type: "get-store" });
  const rules = [...store.rules].sort((a, b) => a.pattern.localeCompare(b.pattern));
  $("empty").hidden = rules.length > 0;
  $("rules").hidden = rules.length === 0;
  // The rows are rebuilt, so the control that had keyboard focus is found again in its new row: the same rule's row,
  // or the one now in its place if that rule was removed.
  const body = $("rules").tBodies[0];
  const focused = document.activeElement;
  const oldRow = body.contains(focused) ? focused.closest("tr") : null;
  const controls = (tr) => [...tr.querySelectorAll("input, textarea, button")];
  const at = oldRow && { id: oldRow.dataset.ruleId, row: [...body.rows].indexOf(oldRow), control: controls(oldRow).indexOf(focused), caret: focused.selectionStart };
  body.replaceChildren(...rules.map(row));
  if (at) {
    const newRow = [...body.rows].find((tr) => tr.dataset.ruleId === at.id) || body.rows[Math.min(at.row, body.rows.length - 1)];
    const list = newRow ? controls(newRow) : [];
    // In another rule's row, its Remove button: the one pressed to get there.
    const control = newRow?.dataset.ruleId === at.id ? list[Math.min(at.control, list.length - 1)] : list.at(-1);
    control?.focus();
    if (typeof at.caret === "number" && typeof control?.selectionStart === "number") control.setSelectionRange(at.caret, at.caret);
  }
  $("ceiling").value = String(store.settings.ceilingDbtp);
  $("access-text").textContent = store.allSites
    ? "The extension can run on every site, and stays idle on a page until you boost it."
    : "The extension asks once for each site you save.";
  $("allow-all").hidden = store.allSites;
  $("each-site").hidden = !store.allSites;
}

$("allow-all").addEventListener("click", () => {
  chrome.permissions.request({ origins: [ALL_SITES] }).then(() => render());
});
$("each-site").addEventListener("click", () => {
  chrome.permissions.remove({ origins: [ALL_SITES] }).then(() => render());
});
$("ceiling").addEventListener("change", async () => {
  await send({ type: "ceiling", db: Number($("ceiling").value) });
  say(`Ceiling set to ${$("ceiling").value} dB.`);
});
$("export").addEventListener("click", async () => {
  const store = await send({ type: "get-store" });
  const out = { schemaVersion: store.schemaVersion, rules: store.rules.map(({ permissionNeeded, ...r }) => r), settings: store.settings };
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: "ultimate-volume-control-settings.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  say(`Exported ${out.rules.length} saved ${out.rules.length === 1 ? "setting" : "settings"}.`);
});
$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files[0];
  if (!file) return;
  const r = await send({ type: "import", text: await file.text() });
  $("import-file").value = "";
  say(r.ok ? `Imported ${r.count} saved ${r.count === 1 ? "setting" : "settings"}. Any marked "Permission needed" stay at 100% until you allow them.` : `Nothing imported. ${r.error}.`);
  render();
});
chrome.permissions.onAdded.addListener(render);
chrome.permissions.onRemoved.addListener(render);
render();
