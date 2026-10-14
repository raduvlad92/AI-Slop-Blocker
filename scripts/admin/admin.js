"use strict";
const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;
let offset = 0, total = 0, selectedId = null, selected = null, nextBefore = null, busy = false;

function notice(message, error = false) {
  $("message").textContent = message;
  $("message").classList.toggle("error", error);
}
function date(value) {
  if (!value) return "No retained reports";
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : value.replace(" ", "T") + "Z";
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? "Unknown date" : parsed.toLocaleString();
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
async function api(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, {
    method, credentials: "omit", headers: { "x-asb-admin": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
async function operation(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try { await action(); }
  catch (error) { notice(error.message || "Could not complete the review. Please retry.", true); }
  finally {
    busy = false;
    document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    $("previous").disabled = offset === 0;
    $("next").disabled = offset + PAGE_SIZE >= total;
  }
}
async function loadContributors() {
  const data = await api(`/contributors?limit=${PAGE_SIZE}&offset=${offset}`);
  total = data.total;
  if (offset >= total && offset > 0) { offset = Math.max(0, offset - PAGE_SIZE); return loadContributors(); }
  $("active").textContent = data.summary.active;
  $("eligible").textContent = data.summary.eligible;
  $("ignored").textContent = data.summary.ignored;
  $("page-label").textContent = total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}` : "0 contributors";
  $("empty").hidden = total !== 0;
  $("contributors").replaceChildren();
  for (const contributor of data.contributors) {
    const row = node("tr");
    row.classList.toggle("selected", contributor.id === selectedId);
    row.append(node("td", contributor.label, "contributor"), node("td", contributor.reports), node("td", contributor.falsePositive), node("td", date(contributor.lastSeen)));
    const statusCell = node("td");
    statusCell.append(node("span", contributor.ignored ? "Ignored" : "Eligible", `pill${contributor.ignored ? " ignored" : ""}`));
    const actionCell = node("td");
    const button = node("button", "Review"); button.type = "button";
    button.setAttribute("aria-label", `Review reports from ${contributor.label}`);
    button.addEventListener("click", () => operation(async () => { await loadDetails(undefined, contributor.id); await loadContributors(); notice(""); $("details").scrollIntoView({ behavior: "smooth", block: "start" }); }));
    actionCell.append(button); row.append(statusCell, actionCell); $("contributors").append(row);
  }
}
function showContributor(contributor) {
  selected = contributor;
  $("details").hidden = false;
  $("contributor-name").textContent = contributor.label;
  $("contributor-id").textContent = `Installation reference: ${contributor.id}`;
  $("contributor-counts").textContent = `${contributor.reports} reports · ${contributor.useful} useful · ${contributor.falsePositive} false positives · ${contributor.pending} unreviewed`;
  $("contributor-status").textContent = contributor.ignored ? "Reports ignored" : "Reports eligible";
  $("contributor-status").className = `pill${contributor.ignored ? " ignored" : ""}`;
  $("ignore-reason").value = contributor.reason || "";
  $("moderate").textContent = contributor.ignored ? "Resume reports" : "Ignore reports";
  $("moderate").classList.toggle("danger", !contributor.ignored);
}
function renderReport(report) {
  const card = node("article", undefined, "report");
  const heading = node("div", undefined, "report-heading");
  heading.append(node("h4", report.channelName || report.channelId || report.videoId || "Reported item"));
  const statusLabels = { pending: "Unreviewed", useful: "Useful", false_positive: "False positive" };
  heading.append(node("span", statusLabels[report.reviewStatus] || "Unreviewed", `pill ${report.reviewStatus}`));
  card.append(heading, node("p", `${report.scope === "channel" ? "Channel" : "Video"} report · ${date(report.createdAt)}`, "metadata"));
  let href;
  if (report.scope === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(report.channelId)) href = `https://www.youtube.com/channel/${report.channelId}`;
  else if (report.scope === "channel" && /^@[^\s/?#]+$/.test(report.channelId)) href = `https://www.youtube.com/${encodeURIComponent(report.channelId)}`;
  else if (/^[A-Za-z0-9_-]{11}$/.test(report.videoId)) href = `https://www.youtube.com/watch?v=${report.videoId}`;
  if (href) { const link = node("a", "Open reported item on YouTube"); link.href = href; link.target = "_blank"; link.rel = "noreferrer noopener"; card.append(link); }
  const actions = node("div", undefined, "actions");
  for (const [status, label] of [["useful", "Useful"], ["false_positive", "False positive"], ["pending", "Reset review"]]) {
    const button = node("button", label); button.type = "button";
    button.classList.toggle("chosen", report.reviewStatus === status);
    button.setAttribute("aria-label", `${label}: ${report.channelName || report.videoId || report.channelId}`);
    button.addEventListener("click", () => operation(async () => {
      await api(`/reports/${report.id}/review`, "PUT", { status });
      await loadDetails(); await loadContributors();
      notice(status === "false_positive" ? "Report marked as a false positive and excluded from community rankings." : "Report review saved.");
    }));
    actions.append(button);
  }
  card.append(actions); $("reports").append(card);
}
async function loadDetails(before, requestedId = selectedId) {
  const data = await api(`/contributors/${requestedId}?limit=${PAGE_SIZE}${before ? `&before=${before}` : ""}`);
  // Commit selection only after its data loads, so a failed switch cannot
  // leave one contributor visible while moderation targets another.
  selectedId = requestedId;
  showContributor(data.contributor);
  if (!before) $("reports").replaceChildren();
  data.reports.forEach(renderReport);
  if (!data.reports.length && !before) $("reports").append(node("p", "No retained report history for this ID.", "muted"));
  nextBefore = data.nextBefore;
  $("older").hidden = !nextBefore;
}
$("refresh").addEventListener("click", () => operation(async () => {
  await loadContributors();
  if (selectedId) { try { await loadDetails(); } catch (error) { if (total === 0) { selectedId = null; $("details").hidden = true; } else throw error; } }
  notice("Review refreshed.");
}));
$("previous").addEventListener("click", () => operation(async () => { offset = Math.max(0, offset - PAGE_SIZE); await loadContributors(); }));
$("next").addEventListener("click", () => operation(async () => { offset += PAGE_SIZE; await loadContributors(); }));
$("older").addEventListener("click", () => operation(() => loadDetails(nextBefore)));
$("moderate").addEventListener("click", () => operation(async () => {
  const ignored = !selected.ignored;
  await api(`/contributors/${selectedId}/moderation`, "PUT", { ignored, reason: $("ignore-reason").value });
  await loadContributors();
  try { await loadDetails(); }
  catch (error) { if (!ignored && selected.reports === 0) { selectedId = null; selected = null; $("details").hidden = true; } else throw error; }
  notice(ignored ? "Reports from this installation are ignored. Their extension continues working." : "Reports from this installation are eligible again.");
}));
operation(async () => {
  const config = await api("/config");
  $("connection").textContent = `Connected to ${new URL(config.backendUrl).hostname}`;
  await loadContributors();
});
