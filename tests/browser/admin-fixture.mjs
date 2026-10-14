// Synthetic admin data only. No reports, credentials or network access to the
// production Worker. Used to exercise the actual local review HTML/JavaScript.
import { startReviewAdmin } from "../../scripts/review-admin.mjs";

const contributorA = "a".repeat(64);
const contributorB = "b".repeat(64);
const history = [
  { id: 2, scope: "channel", videoId: "AAAAAAAAAAA", channelId: "@fixture_creator", channelName: "Fixture creator", createdAt: "2026-10-14 00:10:00", reviewStatus: "pending" },
  { id: 1, scope: "video", videoId: "BBBBBBBBBBB", channelId: "@fixture_video", channelName: "<img src=x onerror=alert('unsafe')>", createdAt: "2026-10-14 00:00:00", reviewStatus: "useful" },
];
const ignored = new Map([[contributorB, "Old fixture reports expired"]]);
let failContributorBOnce = true;

function contributor(id) {
  const reports = id === contributorA ? history : [];
  return {
    id, label: `Contributor ${id.slice(0, 12)}`, reports: reports.length,
    useful: reports.filter((r) => r.reviewStatus === "useful").length,
    falsePositive: reports.filter((r) => r.reviewStatus === "false_positive").length,
    pending: reports.filter((r) => r.reviewStatus === "pending").length,
    firstSeen: reports.at(-1)?.createdAt || null, lastSeen: reports[0]?.createdAt || null,
    ignored: ignored.has(id), reason: ignored.get(id) || "",
  };
}
const app = await startReviewAdmin({
  backendUrl: "https://fixture.invalid", statsKey: "synthetic-admin-key-never-sent-to-browser", port: Number(process.env.ASB_ADMIN_FIXTURE_PORT || 8770),
  async transport({ path, method, body }) {
    const url = new URL(path, "https://fixture.invalid");
    if (url.pathname === "/contributors" && method === "GET") {
      const ids = [contributorA, ...(ignored.has(contributorB) ? [contributorB] : [])];
      return { status: 200, body: { summary: { active: 1, eligible: ignored.has(contributorA) ? 0 : 1, ignored: ignored.size }, contributors: ids.map(contributor), total: ids.length, limit: 50, offset: 0 } };
    }
    const moderation = /^\/contributors\/([ab]{64})\/moderation$/.exec(url.pathname);
    if (moderation && method === "PUT") {
      if (body.ignored) ignored.set(moderation[1], body.reason || ""); else ignored.delete(moderation[1]);
      return { status: 200, body: { ok: true, ignored: body.ignored } };
    }
    const detail = /^\/contributors\/([ab]{64})$/.exec(url.pathname);
    if (detail && method === "GET") {
      if (detail[1] === contributorB && failContributorBOnce) {
        failContributorBOnce = false;
        return { status: 503, body: { error: "Synthetic detail failure; previous selection must stay unchanged" } };
      }
      if (detail[1] === contributorB && !ignored.has(contributorB)) return { status: 404, body: { error: "Contributor not found" } };
      return { status: 200, body: { contributor: contributor(detail[1]), reports: detail[1] === contributorA ? history : [], nextBefore: null } };
    }
    const review = /^\/reports\/(\d+)\/review$/.exec(url.pathname);
    if (review && method === "PUT") {
      history.find((r) => r.id === Number(review[1])).reviewStatus = body.status;
      return { status: 200, body: { ok: true, status: body.status } };
    }
    return { status: 404, body: { error: "Unknown fixture operation" } };
  },
});
console.log(`Synthetic contributor review: ${app.origin} (all data and mutations mocked)`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.server.close(() => process.exit(0)));
