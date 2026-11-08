// What the toolbar icon says about a tab: the tile's colour, and a tooltip. Green is a boost that's running; red is a boost
// that has stopped, may have silenced the page, or can't reach the sound; black is everything else, including a boost not
// started yet. Lowering itself is the boost working, so it stays green. The state is still called the dot ("on", "alert", "").
const percent = (db) => Math.round(100 * Math.pow(10, db / 20));

export function indicator({ frames = {}, capture = false, notReached = false, blocked = false, lowered = "", setDb = 0, saved = false, noAccess = false, doNotRoute = false }) {
  const list = Object.values(frames);
  const has = (status) => list.some((f) => f.status === status);

  if (has("fault")) return { dot: "alert", title: "Boost stopped. Try reloading." };
  if (has("possible-silence")) return { dot: "alert", title: "Page may be silent. Click the icon." };
  if (notReached) return { dot: "alert", title: blocked ? "Can't boost this sound." : "Click the icon to boost." };

  const waiting = list.filter((f) => f.status === "waiting");
  if (waiting.length) return { dot: "", title: waiting.some((f) => f.top) ? "Click the page to boost." : "Click the player to boost." };

  const running = capture || has("active");
  if (!running) {
    if (noAccess) return { dot: "", title: "Boost: off. No site access." };
    if (setDb <= 0 || doNotRoute) return { dot: "", title: "Boost: off." };
    return { dot: "", title: `Boost: off (${percent(setDb)}%). Not started.` };
  }
  if (setDb <= 0) return { dot: "", title: "Boost: off." };
  const set = percent(setDb);
  const now = lowered && Number(lowered) !== set ? `${lowered}% (${set}%)` : `${set}%`;
  return { dot: "on", title: `Boost: ${now}. ${saved ? "Saved." : "Not saved."}` };
}
