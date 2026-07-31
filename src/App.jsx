import React, { useState, useMemo, useCallback, useEffect } from "react";

/* ---------- crash-proofing: never go white, always show the error ---------- */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { this.setState({ err, stack: info?.componentStack }); }
  render() {
    if (this.state.err)
      return (
        <div style={{ background: "#111210", color: "#e4572e", minHeight: "100vh", padding: 24, fontFamily: "monospace", fontSize: 13 }}>
          <div style={{ color: "#f5c518", fontWeight: 700, marginBottom: 10 }}>SONA CONSOLE — render error caught (this replaces the white screen)</div>
          <pre style={{ whiteSpace: "pre-wrap", background: "#0d0e0b", padding: 12, borderRadius: 8 }}>
            {String(this.state.err?.message || this.state.err)}
            {"\n"}{this.state.stack || this.state.err?.stack || ""}
          </pre>
          <button onClick={() => this.setState({ err: null })} style={{ marginTop: 10, padding: "6px 12px", cursor: "pointer" }}>try to recover</button>
        </div>
      );
    return this.props.children;
  }
}

function useGlobalErrors() {
  const [errs, setErrs] = useState([]);
  useEffect(() => {
    const onErr = (e) => setErrs((x) => [...x, `error: ${e.message || e.reason?.message || String(e.reason || e)}`].slice(-5));
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onErr);
    return () => { window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr); };
  }, []);
  return errs;
}

/* ============================================================
   SONA — ARCHITECTURE MODEL / PIPELINE CONSOLE
   Every stage of the pipeline, input → output, inspectable.
   Deterministic core is pure JS. LLM roles call the model API.
   ============================================================ */

/* ---------- date helpers (pure) ---------- */
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(new Date(isoDate + "T00:00:00Z").getTime() + n * DAY);
const daysBetween = (a, b) =>
  Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / DAY);

/* ---------- prompt registry (editable in Prompts tab) ---------- */
const PROMPTS_V1 = {
  extractor: {
    version: "extract.v2",
    text: `You are a task-extraction engine. Convert a raw work input (a to-do list, a course syllabus, or a project outline) into a structured task graph. Do NOT plan, schedule, or break tasks into micro-steps.

RULES
- One task = one deliverable a person could finish in a single sitting. Not a whole milestone. Not a single physical action.
- p10 / p50 / p90: estimate focused working MINUTES — best realistic case, median case, worst realistic case. Assume an average adult, not an expert. p10 <= p50 <= p90. These estimates are the ONLY numbers you may produce.
- deadline: only if the text states or clearly implies one. Resolve relative dates against today. NEVER invent a deadline. Null if none.
- depends_on: task ids that MUST finish before this task can start. Hard deps only.
- cognitive_load: "high" | "medium" | "low".
- uncertainty_driver: "unknown_scope" if the user cannot yet see what the work involves, else "none".
- preferred_daypart: "morning" | "afternoon" | "evening" | "any" — when in the day this kind of work fits best.
- disposition: "do" if it clearly belongs in the plan. null if you genuinely cannot classify the item (vague, maybe-not-a-task). Do not guess: null routes it to the user's triage card.
- Do NOT merge distinct tasks. Do NOT drop small tasks; the small ones matter most.

INPUT
today: {today}
deadline: {deadline}
raw_text:
"""
{raw_text}
"""

OUTPUT — strict JSON only, no prose, no code fences:
{"tasks":[{"id":string,"title":string,"p10":number,"p50":number,"p90":number,"deadline":string|null,"depends_on":string[],"cognitive_load":"high"|"medium"|"low","uncertainty_driver":"none"|"unknown_scope","preferred_daypart":"morning"|"afternoon"|"evening"|"any","disposition":"do"|null}]}`,
  },
  route: {
    version: "route.v1",
    text: `You decompose a project into milestones.

A milestone is a VERIFIABLE DELIVERABLE STATE, not an activity.
  Good: "Chapter 2 drafted"     Bad: "Work on chapter 2"
  Good: "Sources gathered"      Bad: "Research the topic"

Rules:
- Produce between 3 and 7 milestones. Never more, never fewer.
- Every task ID you are given must appear in exactly one milestone.
- Milestone order must respect task dependencies.
- If a task's uncertainty_driver is "unknown_scope", place a scoping milestone before it whose deliverable is that the user now knows what the work involves. Mark it is_scoping: true.
- NEVER output a date, a duration, an hour count, a percentage, or any number except the ordinal. Scheduling is not your job.
- rationale is at most 20 words and is shown to the user.

PROJECT: {project_title}
TASKS (id · title · uncertainty_driver · depends_on):
{task_lines}

Return only valid JSON matching this schema. No prose, no markdown.
{"milestones":[{"ordinal":number,"title":string,"deliverable":string,"task_ids":string[],"is_scoping":boolean,"rationale":string}]}`,
  },
  generator: {
    version: "gen.v2",
    text: `You break a single task into small, immediately startable steps, to defeat task-initiation paralysis. Starting must require zero decisions. The content of the work stays the user's own.

You usually know only the task's title. NEVER invent requirements, methods, structures, or content the title does not state. Your steps must fit ANY reasonable version of this task. If you are unsure how the task is meant to be done, stay method-agnostic — scaffold effort and size, never approach.

RULES
- Every step is a concrete, observable action — something you could watch a person do.
- Step 1 is ALWAYS a trivial setup / friction-reducer: "Open the document.", "Open your laptop."
- Step 2 is the first tiny piece of real work with the quality bar removed: "Write one messy sentence — any sentence."
- Later steps size the next move; they never dictate its content:
  GOOD: "Add three rough bullet points — out of order is fine."
  GOOD: "Skim one source for five minutes."
  BAD: "Draw three lines radiating from the center circle." (invented method)
  BAD: "Use the first three words that come to mind." (dictates the user's content)
- Quantities and durations are friction-reducers ("one sentence", "three rough bullets", "five minutes"), never requirements of the deliverable. When a quantity appears, the wording must make clear that rough, partial, or "any" counts.
- Never tell the user WHAT to write, draw, choose, or conclude — only how small the next move is.
- BANNED: mental verbs with no physical anchor — think, plan, consider, review, understand, decide, figure out, reflect. Convert any mental action to a physical one.
- Each step carries one short permission-granting reassurance (max 6 words): "Just getting ready counts.", "No quality bar.", "Out of order is fine." Never praise, never pressure, never mention time remaining or falling behind.
- For each step, estimate p50 and p90 minutes. Target 2–10 focused minutes per step; p90 (worst case) must stay under 15. These estimates are the ONLY numbers you may produce besides n.
- Produce 4 to 7 steps. If more remain beyond this chunk, set more_steps_exist = true.

TASK
title: {title}
cognitive_load: {cognitive_load}
{failures_block}

OUTPUT — strict JSON only:
{"steps":[{"n":number,"action":string,"reassurance":string,"p50":number,"p90":number}],"more_steps_exist":boolean}`,
  },
  critic: {
    version: "critic.v2",
    text: `You review micro-steps written for a person with ADHD. Your only job: verify each step is a genuinely startable action of honest size that leaves the content of the work to the user.

FAIL a step if any of these hold:
- It is not observable behavior (you could not watch someone do it).
- It prescribes a method, structure, order, or content the task title does not state — invented procedures ("draw three lines from the center", "pick the leftmost branch") or dictated content ("use the first words that come to mind").
- It hides an unbounded decision or judgment ("choose the best", "figure out", "review"). A bounded, explicitly safe choice PASSES: "add a bullet for anything that comes up — no wrong answers."
- It chains multiple actions ("and then", "after that").
- Its realistic worst case exceeds 15 minutes, whatever its stated p90 claims.
- Its stated estimates look dishonest (a 2-minute label on 20-minute work).
- Its reassurance pressures, praises, or mentions time remaining.

Do not rewrite steps. Do not produce any number except step n. Judge, briefly.

STEPS
{steps_json}

OUTPUT — strict JSON only:
{"verdict":"pass"|"fail","failures":[{"n":number,"reason":string}]}`,
  },
  ranker: {
    version: "ranker.v1",
    text: `You choose which tasks matter for tomorrow.

You are given the full remaining task list, each tagged with its milestone, deadline, snooze count, and whether it sits on the critical path for staying on the route.

Pick 3 tasks by default.
Widen to up to 6 only if:
- a task has been snoozed 3 or more times
- a task has a hard deadline within 48 hours
- a task sits on a milestone whose buffer has reached "urgent"

Rules:
- Never mention how many tasks were left out, or how many are left overall.
- Never use the words "overdue," "behind," "urgent," or "need to."
- No numbers of any kind in anything you write. The task list itself carries what the user needs to know.
- Any accompanying line is under 10 words. Neutral. Positive. An invitation, not an instruction.
  Good: "Whenever you're ready."
  Bad: "You have 3 tasks left today, don't fall behind!"

TASKS (id · title · milestone_band · deadline · snoozes · critical_path):
{task_lines}

Return only valid JSON: {"task_ids":string[],"line":string}`,
  },
};

/* ---------- deterministic core (pure, testable) ---------- */

// §3.7 date solver. slackMode: "p10" (sign-consistent with §3.10a) | "spec" (§3.7 literal, p90)
// Buffer-by-construction: planned dates target deadline − 15% of horizon (min 2d);
// latest-safe stays anchored at the real deadline, so a feasible fresh route carries
// genuine slack everywhere — including the terminal milestone (= the reserve itself).
// Done-aware: completed tasks are excluded from pace and downstream sums, so re-solving
// mid-route never degrades an on-track plan.
const BUFFER_FRACTION = 0.15;
function solveRoute(tasks, milestones, today, deadline, slackMode) {
  const totalDays = Math.max(1, daysBetween(today, deadline));
  const reserveDays = Math.min(Math.max(2, Math.ceil(totalDays * BUFFER_FRACTION)), totalDays - 1);
  const workDeadline = addDays(deadline, -Math.max(0, reserveDays)); // plan targets this
  const live = tasks.filter((t) => t.disposition !== "delete");
  const byId = Object.fromEntries(live.map((t) => [t.id, t]));
  const remaining = live.filter((t) => !t.done);
  const totalP50 = remaining.reduce((s, t) => s + t.p50, 0);
  const paceDays = Math.max(1, daysBetween(today, workDeadline));
  const pace = totalP50 / paceDays; // derived min/day over remaining work — L20, never declared
  const ms = [...milestones].sort((a, b) => a.ordinal - b.ordinal);
  const sums = ms.map((m) => {
    const ts = m.task_ids.map((id) => byId[id]).filter((t) => t && !t.done);
    return {
      p10: ts.reduce((s, t) => s + t.p10, 0),
      p50: ts.reduce((s, t) => s + t.p50, 0),
      p90: ts.reduce((s, t) => s + t.p90, 0),
    };
  });
  const solved = ms.map((m, i) => {
    const afterP50 = sums.slice(i + 1).reduce((s, x) => s + x.p50, 0);
    const afterAlt = sums
      .slice(i + 1)
      .reduce((s, x) => s + (slackMode === "spec" ? x.p90 : x.p10), 0);
    const planned = addDays(workDeadline, -Math.ceil(afterP50 / Math.max(pace, 0.001)));
    const latestSafe = addDays(deadline, -Math.ceil(afterAlt / Math.max(pace, 0.001)));
    const slack = daysBetween(planned, latestSafe);
    const complete =
      m.task_ids.length > 0 && m.task_ids.every((id) => !byId[id] || byId[id].done);
    return { ...m, planned_date: planned, latest_safe_date: latestSafe, slack_days: slack, complete };
  });
  return { pace, totalDays, reserveDays, workDeadline, totalP50, milestones: solved };
}

// §3.10 rung-3 bands — deviation-only. A freshly confirmed route has deviated from
// nothing, so it is calm by construction; feasibility itself is the emergency gate's
// job (§3.10a), not the bands'. Bands move only when reality slips against the plan:
//   notice = planned date passed, milestone incomplete
//   urgent = latest-safe passed, or ≤2d away after a slip
function band(m, today) {
  if (m.complete) return "calm";
  const toSafe = daysBetween(today, m.latest_safe_date);
  if (toSafe <= 0) return "urgent";
  if (daysBetween(today, m.planned_date) < 0) return toSafe <= 2 ? "urgent" : "notice";
  return "calm";
}

// §3.10a emergency gate — route-level, p10 sum vs remaining capacity
function emergencyGate(tasks, today, deadline, pace) {
  const remaining = tasks.filter((t) => t.disposition !== "delete" && !t.done);
  const p10Sum = remaining.reduce((s, t) => s + t.p10, 0);
  const capacity = pace * Math.max(0, daysBetween(today, deadline));
  return { p10Sum, capacity, fires: p10Sum > capacity };
}

// Emergency repack — p50 greedy in ranker order, real % reported (code-computed)
function emergencyRepack(orderedTasks, capacityMin) {
  let used = 0;
  const kept = [];
  for (const t of orderedTasks) {
    if (used + t.p50 <= capacityMin) {
      kept.push(t.id);
      used += t.p50;
    }
  }
  const pct = orderedTasks.length ? Math.round((100 * kept.length) / orderedTasks.length) : 0;
  return { kept, pct, used };
}

// §5 reflow — session-boundary, three-way branch
function reflow(steps, committedIds, optionalIds, sessionP50 = 22) {
  const rem = (ids) =>
    steps.filter((s) => ids.includes(s.taskId) && !s.done).reduce((a, s) => a + s.p50, 0);
  const remCommitted = rem(committedIds);
  const remAll = remCommitted + rem(optionalIds);
  if (remAll <= sessionP50) return { branch: "silent", remCommitted, remAll };
  if (remCommitted <= sessionP50) return { branch: "drop_optional", remCommitted, remAll };
  const sessions = Math.ceil(remCommitted / sessionP50);
  return { branch: "surface", remCommitted, remAll, sessionsNeeded: sessions };
}

// L11 mood filter — deterministic, on pre-computed data
function moodFilter(tasks, mood) {
  const todo = tasks.filter((t) => t.disposition === "do" && !t.done);
  const loadRank = { high: 0, medium: 1, low: 2 };
  if (mood === "focused")
    return [...todo].sort((a, b) => loadRank[a.cognitive_load] - loadRank[b.cognitive_load]);
  if (mood === "not_focused") {
    const s = [...todo].sort(
      (a, b) => loadRank[b.cognitive_load] - loadRank[a.cognitive_load] || a.p50 - b.p50
    );
    return s.slice(0, 1); // easiest-first sort → take the first: lowest load, then smallest p50
  }
  return [...todo].sort((a, b) => (a.slack ?? 1e9) - (b.slack ?? 1e9));
}

/* ---------- deterministic validators ---------- */
const NUMERIC_PATTERN = /\d{4}-\d{2}-\d{2}|\d+\s*(h\b|hr|hour|min|day|week|%)/i;
const VERB_STARTERS =
  /^(work|research|write|do|start|make|create|finish|plan|study|read|review|prepare|develop|build|complete|analy[sz]e|organi[sz]e)\b|^\w+ing\b/i;

function validateRoute(out, tasks) {
  const errs = [];
  const ms = out?.milestones;
  if (!Array.isArray(ms)) return ["milestones is not an array"];
  if (ms.length < 3 || ms.length > 7) errs.push(`milestone count ${ms.length} outside 3–7`);
  const assigned = {};
  ms.forEach((m) => (m.task_ids || []).forEach((id) => (assigned[id] = (assigned[id] || 0) + 1)));
  tasks
    .filter((t) => t.disposition !== "delete")
    .forEach((t) => {
      if (!assigned[t.id]) errs.push(`task ${t.id} unassigned`);
      if (assigned[t.id] > 1) errs.push(`task ${t.id} assigned ${assigned[t.id]}×`);
    });
  const ordOf = {};
  ms.forEach((m) => (m.task_ids || []).forEach((id) => (ordOf[id] = m.ordinal)));
  tasks.forEach((t) =>
    (t.depends_on || []).forEach((d) => {
      if (ordOf[t.id] != null && ordOf[d] != null && ordOf[d] > ordOf[t.id])
        errs.push(`dep order: ${t.id} (m${ordOf[t.id]}) depends on ${d} (m${ordOf[d]})`);
    })
  );
  ms.forEach((m) => {
    for (const [k, v] of Object.entries(m))
      if (typeof v === "number" && k !== "ordinal") errs.push(`numeric field "${k}" on m${m.ordinal}`);
    if (NUMERIC_PATTERN.test(m.title + " " + m.deliverable + " " + (m.rationale || "")))
      errs.push(`date/duration pattern in m${m.ordinal} text`);
    if (VERB_STARTERS.test((m.deliverable || "").trim()))
      errs.push(`deliverable of m${m.ordinal} reads as activity: "${m.deliverable}"`);
  });
  return errs;
}

const BANNED_RANKER = /\b(overdue|behind|urgent|need to)\b/i;
function validateRanker(out, validIds) {
  const errs = [];
  if (!Array.isArray(out?.task_ids)) return ["task_ids missing"];
  if (out.task_ids.length < 1 || out.task_ids.length > 6)
    errs.push(`picked ${out.task_ids.length}, expected 1–6`);
  out.task_ids.forEach((id) => {
    if (!validIds.includes(id)) errs.push(`unknown task id ${id}`);
  });
  const line = out.line || "";
  if (/\d/.test(line)) errs.push(`number in line: "${line}"`);
  if (BANNED_RANKER.test(line)) errs.push(`banned word in line: "${line}"`);
  if (line.split(/\s+/).filter(Boolean).length > 10) errs.push("line over 10 words");
  return errs;
}

const MENTAL_VERBS = /\b(think|plan|consider|review|understand|decide|figure out|reflect)\b/i;
// cheap tripwire for known prescriptive tells — the critic carries the real judgment
const PRESCRIPTIVE = /\b(leftmost|rightmost|first (?:\w+ )?(?:words?|things?) that come to mind)\b/i;
function codeCheckSteps(steps) {
  const errs = [];
  steps.forEach((s) => {
    if (MENTAL_VERBS.test(s.action)) errs.push({ n: s.n, reason: `mental verb: "${s.action}"` });
    if (PRESCRIPTIVE.test(s.action)) errs.push({ n: s.n, reason: `prescriptive content: "${s.action}"` });
    if (s.p90 > 15) errs.push({ n: s.n, reason: `p90 ${s.p90} > 15 min ceiling` });
    if (/\band then\b/i.test(s.action)) errs.push({ n: s.n, reason: "chained actions" });
  });
  return errs;
}

/* ---------- self-tests (fixtures, zero network) ---------- */
function runSelfTests() {
  const T = [];
  const t = (name, fn) => {
    try {
      const r = fn();
      T.push({ name, ok: r === true, note: r === true ? "" : String(r) });
    } catch (e) {
      T.push({ name, ok: false, note: e.message });
    }
  };
  const tasks = [
    { id: "a", p10: 60, p50: 120, p90: 240, disposition: "do", depends_on: [] },
    { id: "b", p10: 30, p50: 60, p90: 120, disposition: "do", depends_on: ["a"] },
    { id: "c", p10: 60, p50: 120, p90: 300, disposition: "do", depends_on: [] },
  ];
  const ms = [
    { ordinal: 1, title: "M1", deliverable: "Draft exists", task_ids: ["a"], is_scoping: false },
    { ordinal: 2, title: "M2", deliverable: "Feedback in", task_ids: ["b"], is_scoping: false },
    { ordinal: 3, title: "M3", deliverable: "Final filed", task_ids: ["c"], is_scoping: false },
  ];
  t("date solver: pace = remaining p50 / days-to-buffer-target (L20)", () => {
    const r = solveRoute(tasks, ms, "2026-07-30", "2026-08-29", "p10");
    // horizon 30d → reserve 5d → work deadline 2026-08-24 → 300/25
    return (Math.abs(r.pace - 300 / 25) < 1e-9 && r.workDeadline === "2026-08-24") || `pace ${r.pace} wd ${r.workDeadline}`;
  });
  t("buffer: last milestone planned = deadline − reserve, latest-safe = deadline", () => {
    const r = solveRoute(tasks, ms, "2026-07-30", "2026-08-29", "p10");
    const last = r.milestones[2];
    return (last.planned_date === "2026-08-24" && last.latest_safe_date === "2026-08-29" && last.slack_days === r.reserveDays) || JSON.stringify(last);
  });
  t("done-aware: completed tasks leave pace and sums", () => {
    const withDone = tasks.map((t) => (t.id === "a" ? { ...t, done: true } : t));
    const r = solveRoute(withDone, ms, "2026-08-10", "2026-08-29", "p10");
    return (r.totalP50 === 180 && r.milestones[0].complete === true) || `p50 ${r.totalP50} complete ${r.milestones[0].complete}`;
  });
  t("slack p10-mode is non-negative day one", () => {
    const r = solveRoute(tasks, ms, "2026-07-30", "2026-08-29", "p10");
    return r.milestones.every((m) => m.slack_days >= 0) || JSON.stringify(r.milestones.map((m) => m.slack_days));
  });
  t("SPEC FLAG §3.7: literal p90 mode yields slack ≤ 0 day one", () => {
    const r = solveRoute(tasks, ms, "2026-07-30", "2026-08-29", "spec");
    return r.milestones.slice(0, 2).every((m) => m.slack_days <= 0) || "unexpectedly positive";
  });
  t("band: fresh route is calm end-to-end — terminal milestone included", () => {
    const r = solveRoute(tasks, ms, "2026-07-30", "2026-08-29", "p10");
    const bands = r.milestones.map((m) => band(m, "2026-07-30"));
    return bands.every((b) => b === "calm") || bands.join(",");
  });
  t("band: slipped planned date → notice", () =>
    band({ complete: false, planned_date: "2026-08-01", latest_safe_date: "2026-08-20" }, "2026-08-05") === "notice" || "not notice");
  t("band: latest-safe ≤2d after a slip → urgent", () =>
    band({ complete: false, planned_date: "2026-08-01", latest_safe_date: "2026-08-06" }, "2026-08-05") === "urgent" || "not urgent");
  t("band: latest-safe passed → urgent", () =>
    band({ complete: false, planned_date: "2026-08-01", latest_safe_date: "2026-08-04" }, "2026-08-05") === "urgent" || "not urgent");
  t("band: complete milestone stays calm whatever the date", () =>
    band({ complete: true, planned_date: "2026-08-01", latest_safe_date: "2026-08-02" }, "2026-09-20") === "calm" || "not calm");
  t("p10 gate fires only when best case can't fit", () => {
    const g1 = emergencyGate(tasks, "2026-07-30", "2026-08-29", 10); // cap 300 ≥ p10 150
    const g2 = emergencyGate(tasks, "2026-07-30", "2026-08-03", 10); // cap 40 < 150
    return (!g1.fires && g2.fires) || `g1=${g1.fires} g2=${g2.fires}`;
  });
  t("emergency repack reports real %, not designed target", () => {
    const r = emergencyRepack(
      [{ id: "a", p50: 120 }, { id: "b", p50: 60 }, { id: "c", p50: 120 }],
      150
    );
    return (r.kept.join(",") === "a" && r.pct === 33) || JSON.stringify(r);
  });
  t("reflow: fits → silent", () => {
    const st = [{ taskId: "a", p50: 10, done: false }];
    return reflow(st, ["a"], []).branch === "silent" || reflow(st, ["a"], []).branch;
  });
  t("reflow: fits without optional tier → drop_optional (silent)", () => {
    const st = [
      { taskId: "a", p50: 20, done: false },
      { taskId: "x", p50: 20, done: false },
    ];
    return reflow(st, ["a"], ["x"]).branch === "drop_optional" || reflow(st, ["a"], ["x"]).branch;
  });
  t("reflow: doesn't fit → surface with session count", () => {
    const st = [{ taskId: "a", p50: 50, done: false }];
    const r = reflow(st, ["a"], []);
    return (r.branch === "surface" && r.sessionsNeeded === 3) || JSON.stringify(r);
  });
  t("route validator rejects activity deliverable", () =>
    validateRoute(
      { milestones: [
        { ordinal: 1, title: "x", deliverable: "Working on intro", task_ids: ["a"] },
        { ordinal: 2, title: "y", deliverable: "Draft exists", task_ids: ["b"] },
        { ordinal: 3, title: "z", deliverable: "Final filed", task_ids: ["c"] },
      ] },
      tasks
    ).some((e) => e.includes("activity")) || "not caught");
  t("route validator rejects numeric field", () =>
    validateRoute(
      { milestones: [
        { ordinal: 1, title: "x", deliverable: "Draft exists", task_ids: ["a"], days: 4 },
        { ordinal: 2, title: "y", deliverable: "Feedback in", task_ids: ["b"] },
        { ordinal: 3, title: "z", deliverable: "Final filed", task_ids: ["c"] },
      ] },
      tasks
    ).some((e) => e.includes("numeric")) || "not caught");
  t("ranker validator rejects banned word + number", () => {
    const errs = validateRanker({ task_ids: ["a"], line: "3 tasks left, don't fall behind" }, ["a"]);
    return (errs.length >= 2) || JSON.stringify(errs);
  });
  t("mood not_focused returns exactly 1 (floor)", () => {
    const r = moodFilter(
      [
        { id: "a", disposition: "do", cognitive_load: "high", p50: 60 },
        { id: "b", disposition: "do", cognitive_load: "low", p50: 10 },
      ],
      "not_focused"
    );
    return (r.length === 1 && r[0].id === "b") || JSON.stringify(r.map((x) => x.id));
  });
  return T;
}

/* ---------- LLM plumbing ---------- */
function parseJson(raw) {
  const cleaned = raw.replace(/```json|```/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("no JSON object found");
  return JSON.parse(cleaned.slice(a, b + 1));
}

let LAST_MODEL = "(no call yet)"; // reported by /api/llm per response; env-configured server-side
async function callModel(prompt) {
  const res = await fetch("/api/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status} from /api/llm (non-JSON) — is the Netlify function deployed?`);
  }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.model) LAST_MODEL = data.model;
  return data.text;
}

/* ---------- sample input ---------- */
const SAMPLE = `Course: Research Methods — final assignment
Due end of September.

- Read the two core papers on survey design (Groves ch. 4, Dillman ch. 2)
- Write the literature summary (~2 pages), builds on the reading
- Draft the survey questionnaire — depends on the summary
- Pilot the survey with 5 classmates
- Analyse pilot responses and revise the questionnaire
- Write the final methods report, due the last Friday of September
- Something about the ethics form?? not sure what's involved there
- Email dr. Vermeulen about the dataset access`;

/* ============================================================ UI */
const css = `
/* component layer on the shadcn preset tokens — legacy var names are aliased in index.css */
.sona *{box-sizing:border-box}
.sona{background:var(--background);color:var(--foreground);font-family:'Chivo',ui-sans-serif,sans-serif;min-height:100vh;
  background-image:radial-gradient(circle at 15% 0%, color-mix(in oklch, var(--chart-5) 12%, transparent) 0%, transparent 55%);}
.sona .mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.sona h1{font-weight:900;letter-spacing:-0.02em}
.sona .card{background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:0 1px 2px 0 rgb(0 0 0 / 0.05)}
.sona .btn{background:var(--secondary);border:1px solid var(--border);color:var(--secondary-foreground);
  border-radius:calc(var(--radius) - 2px);padding:6px 12px;font-family:'JetBrains Mono',monospace;font-size:12px;
  cursor:pointer;transition:all .15s}
.sona .btn:hover{border-color:var(--ring);background:color-mix(in oklch, var(--secondary) 80%, var(--foreground) 6%)}
.sona .btn.primary{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:700}
.sona .btn.primary:hover{background:color-mix(in oklch, var(--primary) 88%, var(--primary-foreground) 12%)}
.sona .btn:disabled{opacity:.4;cursor:not-allowed}
.sona .btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.sona .tab{padding:8px 14px;border:none;background:none;color:var(--muted-foreground);cursor:pointer;
  font-family:'JetBrains Mono',monospace;font-size:12px;border-bottom:2px solid transparent;transition:color .15s}
.sona .tab.on{color:var(--chart-2);border-bottom-color:var(--chart-2)}
.sona textarea,.sona input,.sona select{background:transparent;border:1px solid var(--input);color:var(--foreground);
  border-radius:calc(var(--radius) - 2px);padding:8px;font-family:'JetBrains Mono',monospace;font-size:12px;width:100%}
.sona textarea:focus-visible,.sona input:focus-visible,.sona select:focus-visible{outline:2px solid var(--ring);outline-offset:-1px}
.sona .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px;flex:none}
.sona pre{background:color-mix(in oklch, var(--background) 70%, var(--card) 30%);border:1px solid var(--border);
  border-radius:calc(var(--radius) - 2px);padding:10px;font-size:11px;overflow:auto;max-height:280px;
  white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;color:var(--muted-foreground)}
.sona .badge{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 7px;border-radius:calc(var(--radius) - 4px);
  border:1px solid var(--border);text-transform:uppercase;letter-spacing:.05em}
.sona details>summary{cursor:pointer;list-style:none}
.sona details>summary::-webkit-details-marker{display:none}
.sona .yline{height:3px;background:repeating-linear-gradient(90deg,var(--chart-2) 0 26px,transparent 26px 40px);border-radius:2px}
/* ── student-facing session styling (day tab) ── */
.sona .step-card{display:flex;gap:12px;align-items:flex-start;background:var(--secondary);
  border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);padding:14px 16px;margin-bottom:10px}
.sona .step-check{appearance:none;-webkit-appearance:none;width:22px;height:22px;flex:none;margin-top:1px;
  border:2px solid var(--muted-foreground);border-radius:50%;cursor:pointer;display:grid;place-content:center;transition:all .15s}
.sona .step-check:checked{border-color:var(--chart-2);background:var(--chart-2)}
.sona .step-check:checked::after{content:"";width:10px;height:6px;border:2px solid var(--primary-foreground);
  border-top:none;border-right:none;transform:rotate(-45deg) translateY(-1px)}
.sona .chip{display:inline-flex;align-items:center;gap:6px;background:var(--secondary);border:1px solid var(--border);
  border-radius:999px;padding:4px 12px;font-size:12px;color:var(--muted-foreground)}
.sona .chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--warning)}
.sona .reassure{background:color-mix(in oklch, var(--warning) 10%, var(--card));border:1px solid color-mix(in oklch, var(--warning) 35%, transparent);
  border-radius:var(--radius);padding:12px 16px;font-style:italic;color:var(--warning);font-size:13px}
`;

const bandColor = { calm: "var(--success)", notice: "var(--warning)", urgent: "var(--destructive)" };

function Badge({ children, color }) {
  return (
    <span className="badge" style={{ color: color || "var(--dim)", borderColor: color || "var(--line)" }}>
      {children}
    </span>
  );
}

function TraceEntry({ e }) {
  const c = e.status === "ok" ? "var(--green)" : e.status === "warning" ? "var(--amber)" : "var(--red)";
  return (
    <details className="card" style={{ padding: "10px 14px", marginBottom: 8 }}>
      <summary style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="dot" style={{ background: c }} />
        <Badge color={e.kind === "llm" ? "var(--yellow)" : "var(--blue)"}>{e.kind}</Badge>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{e.step}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--dim)", marginLeft: "auto" }}>
          {e.attempts > 1 ? `attempt ${e.attempts} · ` : ""}{e.duration_ms} ms
        </span>
      </summary>
      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        {e.notes?.length > 0 && (
          <div className="mono" style={{ fontSize: 11, color: "var(--amber)" }}>
            {e.notes.map((n, i) => <div key={i}>▸ {n}</div>)}
          </div>
        )}
        {e.prompt && (<div><Badge>exact prompt</Badge><pre>{e.prompt}</pre></div>)}
        {e.raw != null && (<div><Badge>raw model response</Badge><pre>{e.raw}</pre></div>)}
        <div><Badge>{e.kind === "llm" ? "validated output" : "computed output"}</Badge>
          <pre>{JSON.stringify(e.output, null, 2)}</pre></div>
        {e.error && (<div><Badge color="var(--red)">error</Badge><pre style={{ color: "var(--red)" }}>{e.error}</pre></div>)}
      </div>
    </details>
  );
}


/* ---------- session persistence (localStorage — fine outside artifacts) ---------- */
const STORE_KEY = "sona-console-session-v1";
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; }
}

function SonaConsole() {
  const S = useMemo(loadSaved, []);
  const globalErrs = useGlobalErrors();
  const [today, setToday] = useState(S?.today ?? "2026-07-30");
  const [deadline, setDeadline] = useState(S?.deadline ?? "2026-09-25");
  const [title, setTitle] = useState(S?.title ?? "Research Methods — final assignment");
  const [raw, setRaw] = useState(S?.raw ?? SAMPLE);
  const [slackMode, setSlackMode] = useState(S?.slackMode ?? "p10");
  const [theme, setTheme] = useState("dark");
  const [prompts, setPrompts] = useState(() => S?.prompts ?? JSON.parse(JSON.stringify(PROMPTS_V1)));

  const [trace, setTrace] = useState(S?.trace ?? []);
  const [plog, setPlog] = useState(S?.plog ?? []);
  const [tasks, setTasks] = useState(S?.tasks ?? null);
  const [route, setRoute] = useState(S?.route ?? null);
  const [routeConfirmedAt, setRouteConfirmedAt] = useState(S?.routeConfirmedAt ?? null); // L18
  const [ranked, setRanked] = useState(S?.ranked ?? null);
  const [steps, setSteps] = useState(S?.steps ?? null);
  const [mood, setMood] = useState(S?.mood ?? null);
  const [busy, setBusy] = useState(null);
  const [tab, setTab] = useState("trace");
  const [tests, setTests] = useState(null);
  const [sessionLog, setSessionLog] = useState(S?.sessionLog ?? []);

  const addTrace = useCallback((e) => setTrace((t) => [...t, { ...e, ts: Date.now() }]), []);
  const logPred = useCallback(
    (row) => setPlog((p) => [...p, { id: p.length + 1, created_at: new Date().toISOString(), model_id: LAST_MODEL, ...row }]),
    []
  );

  // autosave the whole session (debounced) so refreshes and long tests survive
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          today, deadline, title, raw, slackMode, prompts, trace, plog,
          tasks, route, routeConfirmedAt, ranked, steps, mood, sessionLog,
        }));
      } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [today, deadline, title, raw, slackMode, prompts, trace, plog, tasks, route, routeConfirmedAt, ranked, steps, mood, sessionLog]);

  function resetSession() {
    if (!window.confirm("Clear the saved session and start clean?")) return;
    try { localStorage.removeItem(STORE_KEY); } catch {}
    window.location.reload();
  }
  function exportSession() {
    const blob = new Blob([localStorage.getItem(STORE_KEY) || "{}"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sona-console-session.json";
    a.click();
  }
  function importSession(file) {
    const r = new FileReader();
    r.onload = () => { try { localStorage.setItem(STORE_KEY, r.result); window.location.reload(); } catch {} };
    r.readAsText(file);
  }

  /* --- generic LLM stage runner with validate + one repair retry --- */
  async function llmStage(step, promptText, version, validate) {
    const t0 = performance.now();
    let attempts = 0, rawResp = "", notes = [];
    let prompt = promptText;
    while (attempts < 2) {
      attempts++;
      rawResp = await callModel(prompt);
      try {
        const parsed = parseJson(rawResp);
        const errs = validate ? validate(parsed) : [];
        if (errs.length === 0) {
          addTrace({ step, kind: "llm", status: attempts > 1 ? "warning" : "ok", duration_ms: Math.round(performance.now() - t0), prompt: promptText, raw: rawResp, output: parsed, attempts, notes });
          logPred({ entity_type: step, entity_id: null, predicted_p50: null, predicted_p90: null, actual_minutes: null, censored: false, prompt_version: version });
          return parsed;
        }
        notes.push(`validation failed (attempt ${attempts}): ${errs.join(" · ")}`);
        prompt = promptText + `\n\nYour previous response violated these rules — fix them and return ONLY the corrected JSON:\n- ` + errs.join("\n- ");
      } catch (e) {
        notes.push(`parse failed (attempt ${attempts}): ${e.message}`);
        prompt = promptText + `\n\nYour previous response was not valid JSON matching the schema. Return ONLY the JSON object, no prose, no code fences.`;
      }
    }
    addTrace({ step, kind: "llm", status: "error", duration_ms: Math.round(performance.now() - t0), prompt: promptText, raw: rawResp, output: null, attempts, notes, error: "failed after max attempts — failing loud, not silently accepting" });
    throw new Error(`${step}: failed validation after ${attempts} attempts`);
  }

  function codeStage(step, input, fn, notes = []) {
    const t0 = performance.now();
    const out = fn(input);
    addTrace({ step, kind: "code", status: "ok", duration_ms: Math.max(1, Math.round(performance.now() - t0)), output: out, notes });
    return out;
  }

  /* --- stage 1: Extractor --- */
  async function runExtract() {
    setBusy("extract");
    try {
      const p = prompts.extractor.text.replace("{today}", today).replace("{deadline}", deadline).replace("{raw_text}", raw);
      const out = await llmStage("extractor", p, prompts.extractor.version, (o) => {
        if (!Array.isArray(o.tasks) || o.tasks.length === 0) return ["tasks missing/empty"];
        const errs = [];
        o.tasks.forEach((t) => {
          if (!(t.p10 <= t.p50 && t.p50 <= t.p90)) errs.push(`${t.id}: p10≤p50≤p90 violated`);
          if (t.disposition !== "do" && t.disposition !== null) errs.push(`${t.id}: disposition must be "do" or null`);
        });
        return errs;
      });
      setTasks(out.tasks.map((t) => ({ ...t, done: false, snoozes: 0 })));
      setRoute(null); setRanked(null); setSteps(null); setRouteConfirmedAt(null);
    } catch (e) { /* trace already has it */ }
    setBusy(null);
  }

  /* --- stage 2: triage (user gesture → disposition, §4.2 / L19) --- */
  function triage(id, disposition) {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, disposition } : t)));
    addTrace({ step: "triage_card", kind: "code", status: "ok", duration_ms: 0, output: { task: id, gesture: { do: "swipe left", delete: "swipe down", date: "swipe right", delegate: "swipe up" }[disposition], wrote: `task.disposition = "${disposition}"` } });
  }

  /* --- stage 3: Route Planner + date solver --- */
  async function runRoute() {
    setBusy("route");
    try {
      const live = tasks.filter((t) => t.disposition && t.disposition !== "delete");
      const lines = live.map((t) => `${t.id} · ${t.title} · ${t.uncertainty_driver} · deps:[${t.depends_on.join(",")}]`).join("\n");
      const p = prompts.route.text.replace("{project_title}", title).replace("{task_lines}", lines);
      const out = await llmStage("route_planner", p, prompts.route.version, (o) => validateRoute(o, live));
      const solved = codeStage("date_solver (§3.7)", { tasks: live, milestones: out.milestones, today, deadline, slackMode }, (i) => {
        const r = solveRoute(i.tasks, i.milestones, i.today, i.deadline, i.slackMode);
        return { derived_pace_min_per_day: +r.pace.toFixed(1), reserve_days: r.reserveDays, work_deadline: r.workDeadline, note: "pace = Σ remaining p50 / days-to-buffer-target (deadline − 15%) — L20, nothing declared", milestones: r.milestones.map((m) => ({ ordinal: m.ordinal, title: m.title, planned_date: m.planned_date, latest_safe_date: m.latest_safe_date, slack_days: m.slack_days, complete: m.complete, band: band(m, i.today) })) };
      }, [slackMode === "spec" ? "SPEC-LITERAL mode: §3.7 step 3 as written (p90) — expect slack ≤ 0, see Tests tab" : "p10-consistent mode: latest-safe uses p10, matching §3.10a's 'even the best case' convention"]);
      setRoute(solved);
    } catch (e) {}
    setBusy(null);
  }

  /* --- stage 4: Ranker --- */
  async function runRanker() {
    setBusy("rank");
    try {
      const live = tasks.filter((t) => t.disposition === "do" && !t.done);
      const bandOf = (t) => {
        const m = route.milestones.find((m) => true); // enrich below
        const mm = route.milestones.find((x) => (routeMilestoneTasks[x.ordinal] || []).includes(t.id));
        return mm ? mm.band : "calm";
      };
      const routeMilestoneTasks = {};
      route.milestones.forEach((m) => { routeMilestoneTasks[m.ordinal] = tasksOfMilestone(m.ordinal); });
      const lines = live.map((t) => `${t.id} · ${t.title} · ${bandOf(t)} · ${t.deadline || "—"} · snoozes:${t.snoozes} · critical:${t.depends_on.length === 0 ? "yes" : "no"}`).join("\n");
      const p = prompts.ranker.text.replace("{task_lines}", lines);
      const out = await llmStage("importance_ranker", p, prompts.ranker.version, (o) => validateRanker(o, live.map((t) => t.id)));
      setRanked(out);
    } catch (e) {}
    setBusy(null);
  }
  function tasksOfMilestone(ord) {
    // read from last route_planner trace output
    const rt = [...trace].reverse().find((e) => e.step === "route_planner" && e.status !== "error");
    const m = rt?.output?.milestones?.find((m) => m.ordinal === ord);
    return m?.task_ids || [];
  }

  /* --- stage 5: Generator + Critic loop (max 2 rounds, fail loud) --- */
  async function runBreakdown(taskIdArg) {
    setBusy("steps");
    try {
      // explicit id wins; otherwise head of the mood-ordered queue (not-done only).
      const wanted = typeof taskIdArg === "string" ? taskIdArg : null;
      const task =
        (wanted && tasks.find((t) => t.id === wanted)) ||
        surfaced[0] ||
        tasks.find((t) => ranked.task_ids.includes(t.id) && !t.done);
      if (!task) { setBusy(null); return; }
      let round = 0, current = null, failures = null, warning = false;
      while (round < 2) {
        round++;
        const fb = failures ? `PREVIOUS ATTEMPT FAILED REVIEW — fix these and return the FULL corrected list:\n${failures.map((f) => `step ${f.n}: ${f.reason}`).join("\n")}` : "";
        const gp = prompts.generator.text.replace("{title}", task.title).replace("{cognitive_load}", task.cognitive_load).replace("{failures_block}", fb);
        const gen = await llmStage(`micro_step_generator (round ${round})`, gp, prompts.generator.version, (o) => {
          if (!Array.isArray(o.steps) || o.steps.length < 2) return ["steps missing"];
          return [];
        });
        const codeErrs = codeStage(`step_code_checks (round ${round})`, gen.steps, codeCheckSteps,
          ["deterministic pre-filter: mental verbs, chaining, p90≤15"]);
        const cp = prompts.critic.text.replace("{steps_json}", JSON.stringify(gen.steps, null, 1));
        const crit = await llmStage(`micro_step_critic (round ${round})`, cp, prompts.critic.version, (o) =>
          o.verdict === "pass" || o.verdict === "fail" ? [] : ["verdict must be pass|fail"]);
        const allFails = [...codeErrs, ...(crit.verdict === "fail" ? crit.failures || [] : [])];
        gen.steps.forEach((s) => { logPred({ entity_type: "micro_step", entity_id: `${task.id}/s${s.n}`, predicted_p50: s.p50, predicted_p90: s.p90, actual_minutes: null, censored: false, prompt_version: prompts.generator.version }); });
        if (allFails.length === 0) { current = gen; break; }
        failures = allFails; current = gen;
        if (round === 2) { warning = true;
          addTrace({ step: "critic_loop_exhausted", kind: "code", status: "warning", duration_ms: 0, output: { quality_warning: true, remaining_failures: allFails }, notes: ["max 2 rounds reached — failing loud with quality_warning, not silently accepting"] }); }
      }
      setSteps({ taskId: task.id, taskTitle: task.title, quality_warning: warning, list: current.steps.map((s) => ({ ...s, taskId: task.id, done: false, actual: s.p50 })) });
    } catch (e) {}
    setBusy(null);
  }

  /* --- stage 6: mood variants (code, L11) --- */
  function runMood(m) {
    setMood(m);
    codeStage(`mood_filter (${m})`, m, (mm) => {
      const r = moodFilter(tasks.map((t) => ({ ...t, slack: taskSlack[t.id] ?? 0 })), mm);
      return { mood: mm, surfaced: r.map((t) => `${t.id} · ${t.title}`), rule: mm === "focused" ? "all, highest cognitive load first" : mm === "not_focused" ? "one task only — easiest win" : "all, ascending milestone slack" };
    }, ["deterministic filter on pre-computed plan — no model call, L11 — reorders the day queue live"]);
  }

  /* --- day sim: tick + session boundary reflow --- */
  function tick(n, val) { setSteps((s) => ({ ...s, list: s.list.map((x) => (x.n === n ? { ...x, done: val } : x)) })); }
  function setActual(n, v) { setSteps((s) => ({ ...s, list: s.list.map((x) => (x.n === n ? { ...x, actual: v } : x)) })); }
  function endSession() {
    steps.list.filter((s) => s.done && !s.logged).forEach((s) => {
      logPred({ entity_type: "micro_step_actual", entity_id: `${steps.taskId}/s${s.n}`, predicted_p50: s.p50, predicted_p90: s.p90, actual_minutes: +s.actual, censored: false, prompt_version: prompts.generator.version });
    });
    setSteps((st) => ({ ...st, list: st.list.map((x) => (x.done ? { ...x, logged: true } : x)) }));
    const allDone = steps.list.every((x) => x.done);
    const committed = (ranked ? ranked.task_ids.slice(0, 3) : [steps.taskId]).filter((id) => {
      const t = tasks.find((x) => x.id === id);
      return t && !t.done;
    });
    const optional = ranked ? ranked.task_ids.slice(3) : [];
    const r = codeStage("reflow (§5, session boundary)", null, () => reflow(steps.list, committed, optional),
      ["three-way branch: silent / drop optional tier / surface — never per-tick"]);
    setSessionLog((l) => [...l, r]);
    if (allDone) {
      setTasks((ts) => ts.map((t) => (t.id === steps.taskId ? { ...t, done: true } : t)));
      addTrace({ step: "task_complete", kind: "code", status: "ok", duration_ms: 0, output: { task: steps.taskId, wrote: "task.done = true" }, notes: ["all micro-steps ticked → parent task done, session cleared, queue advances"] });
      setSteps(null);
    }
  }

  /* --- day queue: milestone slack per task + mood-ordered surfaced list --- */
  const taskSlack = useMemo(() => {
    if (!route) return {};
    const map = {};
    route.milestones.forEach((m) => (tasksOfMilestone(m.ordinal) || []).forEach((id) => (map[id] = m.slack_days)));
    return map;
  }, [route, trace]);
  const surfaced = useMemo(() => {
    if (!ranked || !tasks) return [];
    const pool = ranked.task_ids
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t) => t && !t.done)
      .map((t) => ({ ...t, slack: taskSlack[t.id] ?? 0 }));
    return mood ? moodFilter(pool, mood) : pool;
  }, [ranked, tasks, mood, taskSlack]);

  /* --- emergency gate view --- */
  const gate = useMemo(() => {
    if (!tasks || !route) return null;
    const live = tasks.filter((t) => t.disposition === "do");
    const pace = route.derived_pace_min_per_day;
    const g = emergencyGate(live, today, deadline, pace);
    const repack = g.fires && ranked ? emergencyRepack(ranked.task_ids.map((id) => live.find((t) => t.id === id)).filter(Boolean), g.capacity) : null;
    return { ...g, pace, repack };
  }, [tasks, route, ranked, today, deadline]);

  const triageQueue = tasks?.filter((t) => t.disposition === null) || [];
  const canRoute = tasks && triageQueue.length === 0;

  const stages = [
    { key: "extract", label: "1 · Extractor", kind: "llm", ready: true, done: !!tasks, run: runExtract },
    { key: "triage", label: `2 · Triage (${triageQueue.length} open)`, kind: "user", ready: !!tasks, done: tasks && triageQueue.length === 0, run: null },
    { key: "route", label: "3 · Route Planner + date solver", kind: "llm+code", ready: canRoute, done: !!route, run: runRoute },
    { key: "rank", label: "4 · Importance Ranker", kind: "llm", ready: !!route, done: !!ranked, run: runRanker },
    { key: "steps", label: "5 · Generator ⇄ Critic (≤2)", kind: "llm", ready: !!ranked, done: !!steps, run: () => runBreakdown() },
    { key: "mood", label: "6 · Mood variants", kind: "code", ready: !!ranked, done: !!mood, run: () => runMood("middle") },
  ];

  return (
    <div className={"sona" + (theme === "dark" ? " dark" : "")}>
      <style>{css}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 20px 80px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
          <h1 style={{ fontSize: 30, margin: 0 }}>SONA</h1>
          <span className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>architecture model · pipeline console</span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--dim)" }}>
            L18 route confirmation: {routeConfirmedAt ? <span style={{ color: "var(--green)" }}>confirmed {routeConfirmedAt}</span> : route ? <span style={{ color: "var(--amber)" }}>● pending — proceeding on proposal</span> : "—"}
          </span>
          <button className="btn" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>{theme === "dark" ? "☀ light" : "☾ dark"}</button>
          <button className="btn" onClick={exportSession}>save session</button>
          <label className="btn" style={{ display: "inline-block" }}>
            load<input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => e.target.files[0] && importSession(e.target.files[0])} />
          </label>
          <button className="btn" onClick={resetSession}>reset</button>
        </div>
        <div className="yline" style={{ marginBottom: 22 }} />
        {globalErrs.length > 0 && (
          <div className="card mono" style={{ padding: 10, marginBottom: 14, borderColor: "var(--red)", color: "var(--red)", fontSize: 11 }}>
            {globalErrs.map((e, i) => <div key={i}>⚠ {e}</div>)}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "330px 1fr", gap: 18 }}>
          {/* LEFT: config + pipeline */}
          <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
            <div className="card" style={{ padding: 14 }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--yellow)", marginBottom: 10, letterSpacing: ".1em" }}>INPUT</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <div><label className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>today</label><input value={today} onChange={(e) => setToday(e.target.value)} /></div>
                <div><label className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>deadline</label><input value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div>
              </div>
              <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 8 }} />
              <textarea rows={9} value={raw} onChange={(e) => setRaw(e.target.value)} />
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <label className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>slack mode</label>
                <select value={slackMode} onChange={(e) => setSlackMode(e.target.value)} style={{ width: "auto" }}>
                  <option value="p10">p10-consistent (proposed)</option>
                  <option value="spec">§3.7 literal (p90)</option>
                </select>
              </div>
            </div>

            <div className="card" style={{ padding: 14 }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--yellow)", marginBottom: 10, letterSpacing: ".1em" }}>PIPELINE</div>
              <div style={{ display: "grid", gap: 7 }}>
                {stages.map((s) => (
                  <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="dot" style={{ background: s.done ? "var(--green)" : s.ready ? "var(--yellow)" : "var(--line)" }} />
                    <span className="mono" style={{ fontSize: 12, flex: 1, color: s.ready ? "var(--ink)" : "var(--dim)" }}>{s.label}</span>
                    <Badge>{s.kind}</Badge>
                    {s.run && <button className="btn" disabled={!s.ready || busy} onClick={s.run}>{busy === s.key ? "…" : "run"}</button>}
                  </div>
                ))}
              </div>
              {route && !routeConfirmedAt && (
                <button className="btn primary" style={{ marginTop: 12, width: "100%" }} onClick={() => setRouteConfirmedAt(new Date().toISOString().slice(0, 16).replace("T", " "))}>
                  confirm route (L18 — the implementation-intention moment)
                </button>
              )}
            </div>

            {gate && (
              <div className="card" style={{ padding: 14, borderColor: gate.fires ? "var(--red)" : "var(--line)" }}>
                <div className="mono" style={{ fontSize: 11, color: gate.fires ? "var(--red)" : "var(--yellow)", marginBottom: 8, letterSpacing: ".1em" }}>
                  §3.10a EMERGENCY GATE {gate.fires ? "· FIRES" : "· closed"}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--dim)", lineHeight: 1.7 }}>
                  Σ p10 remaining = <b style={{ color: "var(--ink)" }}>{gate.p10Sum} min</b><br />
                  capacity to deadline = pace {gate.pace} × {Math.max(0, daysBetween(today, deadline))}d = <b style={{ color: "var(--ink)" }}>{Math.round(gate.capacity)} min</b><br />
                  gate: p10 {gate.fires ? ">" : "≤"} capacity → {gate.fires ? "even the best case doesn't fit" : "destination still reachable"}
                </div>
                {gate.repack && (
                  <div className="mono" style={{ fontSize: 11, marginTop: 8, color: "var(--amber)" }}>
                    repack (p50, ranker order): keeps [{gate.repack.kept.join(", ")}] → real {gate.repack.pct}% — honest, not designed
                  </div>
                )}
                <div className="mono" style={{ fontSize: 10, color: "var(--dim)", marginTop: 8 }}>tip: pull the deadline closer to watch the gate fire</div>
              </div>
            )}
          </div>

          {/* RIGHT: tabs */}
          <div>
            <div style={{ borderBottom: "1px solid var(--line)", marginBottom: 14, display: "flex", flexWrap: "wrap" }}>
              {["trace", "graph", "route", "day", "log", "tests", "prompts"].map((t) => (
                <button key={t} className={"tab" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>
                  {t}{t === "trace" && trace.length ? ` (${trace.length})` : ""}{t === "log" && plog.length ? ` (${plog.length})` : ""}
                </button>
              ))}
            </div>

            {tab === "trace" && (
              <div>
                {trace.length === 0 && <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>Run stage 1 to start. Every step lands here — exact prompt, raw response, validation, attempts.</div>}
                {trace.map((e, i) => <TraceEntry key={i} e={e} />)}
              </div>
            )}

            {tab === "graph" && (
              <div style={{ display: "grid", gap: 8 }}>
                {!tasks && <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>No task graph yet — run the Extractor.</div>}
                {triageQueue.length > 0 && (
                  <div className="card" style={{ padding: 14, borderColor: "var(--yellow)" }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--yellow)", marginBottom: 8 }}>TRIAGE — the one manual classification moment (L19)</div>
                    {triageQueue.map((t) => (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 12, flex: 1, minWidth: 180 }}>{t.title}</span>
                        <button className="btn" onClick={() => triage(t.id, "do")}>← do</button>
                        <button className="btn" onClick={() => triage(t.id, "delete")}>↓ delete</button>
                        <button className="btn" onClick={() => triage(t.id, "date")}>→ date</button>
                        <button className="btn" onClick={() => triage(t.id, "delegate")}>↑ delegate</button>
                      </div>
                    ))}
                  </div>
                )}
                {tasks?.map((t) => (
                  <div key={t.id} className="card" style={{ padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", opacity: t.disposition === "delete" ? 0.4 : 1 }}>
                    <span className="mono" style={{ fontSize: 11, color: "var(--yellow)" }}>{t.id}</span>
                    <span style={{ fontSize: 13, flex: 1, minWidth: 160 }}>{t.title}</span>
                    <Badge>p {t.p10}/{t.p50}/{t.p90}m</Badge>
                    <Badge color={t.cognitive_load === "high" ? "var(--red)" : t.cognitive_load === "low" ? "var(--green)" : "var(--amber)"}>{t.cognitive_load}</Badge>
                    <Badge>{t.preferred_daypart}</Badge>
                    {t.uncertainty_driver === "unknown_scope" && <Badge color="var(--blue)">unknown_scope</Badge>}
                    <Badge color={t.disposition ? "var(--green)" : "var(--amber)"}>{t.disposition || "→ triage"}</Badge>
                    {t.depends_on.length > 0 && <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>deps: {t.depends_on.join(",")}</span>}
                  </div>
                ))}
              </div>
            )}

            {tab === "route" && (
              <div style={{ display: "grid", gap: 10 }}>
                {!route && <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>No route yet — clear triage, then run stage 3.</div>}
                {route && (
                  <>
                    <div className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
                      derived pace <b style={{ color: "var(--yellow)" }}>{route.derived_pace_min_per_day} min/day</b> — Σ remaining p50 ÷ days to buffer target {route.work_deadline} (reserve {route.reserve_days}d ≈ 15%), nothing declared (L20) · slack mode: {slackMode}
                    </div>
                    {route.milestones.map((m) => (
                      <div key={m.ordinal} className="card" style={{ padding: 14, borderLeft: `4px solid ${bandColor[m.band]}` }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="mono" style={{ color: "var(--yellow)", fontWeight: 700 }}>M{m.ordinal}</span>
                          <span style={{ fontWeight: 700 }}>{m.title}</span>
                          <Badge color={bandColor[m.band]}>{m.band}</Badge>
                          <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--dim)" }}>
                            planned {m.planned_date} · latest-safe {m.latest_safe_date} · slack <b style={{ color: m.slack_days < 0 ? "var(--red)" : "var(--ink)" }}>{m.slack_days}d</b>
                          </span>
                        </div>
                      </div>
                    ))}
                    <div className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
                      Band = rung 3 of the reroute ladder: deviation-only, no model call. A fresh confirmed route is calm by construction (plan reserves ~15% of horizon; feasibility itself = emergency gate §3.10a). notice = planned date slipped · urgent = latest-safe passed or ≤2d after a slip.
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === "day" && (
              <div style={{ display: "grid", gap: 12 }}>
                {ranked && (
                  <div className="card" style={{ padding: 14 }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--yellow)", marginBottom: 8 }}>TOMORROW — Ranker output (§3.10b tone)</div>
                    {ranked.task_ids.map((id, i) => {
                      const t = tasks.find((x) => x.id === id);
                      return <div key={id} className="mono" style={{ fontSize: 13, padding: "3px 0", color: i < 3 ? "var(--ink)" : "var(--dim)" }}>{t?.title || id}{i >= 3 && <span style={{ fontSize: 10 }}> · if there's room</span>}</div>;
                    })}
                    {ranked.line && <div style={{ marginTop: 8, fontStyle: "italic", color: "var(--dim)", fontSize: 13 }}>{ranked.line}</div>}
                  </div>
                )}
                {ranked && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>mood →</span>
                    {["focused", "middle", "not_focused"].map((m) => (
                      <button key={m} className={"btn" + (mood === m ? " primary" : "")} onClick={() => runMood(m)}>{m}</button>
                    ))}
                    <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>deterministic filter, zero morning latency (L11) — reorders the queue below</span>
                  </div>
                )}
                {ranked && (
                  <div className="card" style={{ padding: 14 }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--yellow)", marginBottom: 8 }}>QUEUE — mood-ordered · done tasks drop out</div>
                    {surfaced.length === 0 && <div className="mono" style={{ fontSize: 12, color: "var(--green)" }}>queue clear — every surfaced task is done</div>}
                    {surfaced.map((t) => (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                        <span style={{ fontSize: 13, flex: 1, color: steps?.taskId === t.id ? "var(--yellow)" : "var(--ink)" }}>{t.title}</span>
                        <Badge>p50 {t.p50}m</Badge>
                        <button className="btn" disabled={busy === "steps"} onClick={() => runBreakdown(t.id)}>{steps?.taskId === t.id ? "re-chunk ↻" : "break down →"}</button>
                      </div>
                    ))}
                  </div>
                )}
                {steps && (
                  <div className="card" style={{ padding: 22 }}>
                    <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted-foreground)", marginBottom: 6 }}>
                      Breaking it down {steps.quality_warning && <Badge color="var(--warning)">quality_warning</Badge>}
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.25, marginBottom: 4 }}>{steps.taskTitle}</div>
                    <div style={{ color: "var(--muted-foreground)", fontSize: 14, marginBottom: 14 }}>Let's make this feel smaller.</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
                      <span className="chip">About {steps.list.filter((s) => !s.done).reduce((a, s) => a + (+s.p50 || 0), 0)} min remaining</span>
                      <span className="chip">{steps.list.filter((s) => !s.done).length} small step{steps.list.filter((s) => !s.done).length === 1 ? "" : "s"} ahead</span>
                    </div>
                    {steps.list.map((s) => (
                      <div key={s.n} className="step-card" style={{ opacity: s.done ? 0.55 : 1 }}>
                        <input type="checkbox" className="step-check" checked={s.done} onChange={(e) => tick(s.n, e.target.checked)} />
                        <span style={{ flex: 1 }}>
                          <span style={{ fontSize: 15, fontWeight: 700, display: "block", textDecoration: s.done ? "line-through" : "none" }}>{s.action}</span>
                          {s.reassurance && <span style={{ fontSize: 13, color: "var(--muted-foreground)", display: "block", marginTop: 2 }}>{s.reassurance}</span>}
                          {s.done && <span className="mono" style={{ fontSize: 10, color: "var(--muted-foreground)", display: "block", marginTop: 6 }}>actual <input type="number" value={s.actual} onChange={(e) => setActual(s.n, e.target.value)} style={{ width: 56, padding: 2, display: "inline-block" }} />m</span>}
                        </span>
                        <span className="mono" style={{ fontSize: 11, color: "var(--muted-foreground)", flex: "none", marginTop: 4 }}>~{s.p50} min</span>
                      </div>
                    ))}
                    <div className="reassure" style={{ marginTop: 4 }}>It's okay if this stays rough. We're just starting.</div>
                    <button className="btn primary" style={{ marginTop: 14 }} onClick={endSession}>end session → reflow (§5)</button>
                    {sessionLog.map((r, i) => (
                      <div key={i} className="mono" style={{ fontSize: 11, marginTop: 8, color: r.branch === "surface" ? "var(--amber)" : "var(--green)" }}>
                        session {i + 1}: <b>{r.branch}</b>{r.branch === "silent" && " — no UI change, Maps doesn't announce recalculating"}{r.branch === "drop_optional" && " — optional tier dropped, silently"}{r.branch === "surface" && ` — took longer than we thought. ${r.sessionsNeeded} more session${r.sessionsNeeded > 1 ? "s" : ""} should do it. [Take 5] [Keep going] [Stop here]`}
                      </div>
                    ))}
                  </div>
                )}
                {!ranked && <div className="mono" style={{ color: "var(--dim)", fontSize: 12 }}>Run stages 4–5 first.</div>}
              </div>
            )}

            {tab === "log" && (
              <div>
                <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 10 }}>
                  predictions_log — L10, in-memory sink here, Supabase sink in production. Same row shape from day one. Every model run + every tick lands here.
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="mono" style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
                    <thead><tr style={{ color: "var(--yellow)", textAlign: "left" }}>
                      {["id", "entity_type", "entity_id", "p50", "p90", "actual", "prompt_version", "model_id"].map((h) => <th key={h} style={{ padding: "4px 8px", borderBottom: "1px solid var(--line)" }}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {plog.map((r) => (
                        <tr key={r.id} style={{ borderBottom: "1px solid var(--line)" }}>
                          <td style={{ padding: "4px 8px" }}>{r.id}</td><td style={{ padding: "4px 8px" }}>{r.entity_type}</td>
                          <td style={{ padding: "4px 8px" }}>{r.entity_id || "—"}</td>
                          <td style={{ padding: "4px 8px" }}>{r.predicted_p50 ?? "∅"}</td><td style={{ padding: "4px 8px" }}>{r.predicted_p90 ?? "∅"}</td>
                          <td style={{ padding: "4px 8px", color: r.actual_minutes != null ? "var(--green)" : "var(--dim)" }}>{r.actual_minutes ?? "∅"}</td>
                          <td style={{ padding: "4px 8px" }}>{r.prompt_version}</td><td style={{ padding: "4px 8px" }}>{r.model_id}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {plog.length > 0 && <button className="btn" style={{ marginTop: 10 }} onClick={() => { const blob = new Blob([JSON.stringify(plog, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "predictions_log.json"; a.click(); }}>export JSON</button>}
              </div>
            )}

            {tab === "tests" && (
              <div>
                <button className="btn primary" onClick={() => setTests(runSelfTests())}>run deterministic self-tests (zero network)</button>
                {tests && (
                  <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                    {tests.map((x, i) => (
                      <div key={i} className="mono" style={{ fontSize: 12, display: "flex", gap: 8 }}>
                        <span style={{ color: x.ok ? "var(--green)" : "var(--red)" }}>{x.ok ? "✓" : "✗"}</span>
                        <span style={{ color: x.name.startsWith("SPEC FLAG") ? "var(--amber)" : "var(--ink)" }}>{x.name}</span>
                        {x.note && <span style={{ color: "var(--red)" }}>{x.note}</span>}
                      </div>
                    ))}
                    <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 4, columnCount: 1 }}>
                      {tests.filter((x) => x.ok).length}/{tests.length} passing. The SPEC FLAG test passes by demonstrating the §3.7-literal formula's slack goes non-positive — that's the point.
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "prompts" && (
              <div style={{ display: "grid", gap: 12 }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>The tuning surface. Edits apply to the next run of that stage — session-only.</div>
                {Object.entries(prompts).map(([k, v]) => (
                  <details key={k} className="card" style={{ padding: 14 }}>
                    <summary className="mono" style={{ fontSize: 12, color: "var(--yellow)" }}>{k} · {v.version}</summary>
                    <textarea rows={14} style={{ marginTop: 10 }} value={v.text} onChange={(e) => setPrompts((p) => ({ ...p, [k]: { ...p[k], text: e.target.value } }))} />
                  </details>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Boundary>
      <SonaConsole />
    </Boundary>
  );
}
