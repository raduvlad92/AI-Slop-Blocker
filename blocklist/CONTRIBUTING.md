# Contributing to the community blocklist

These two files are what every AI Slop Blocker install fetches directly from
GitHub raw and applies alongside each user's personal list:

- `videos.json` — blocked YouTube videos
- `channels.json` — blocked YouTube channels

Both lists are currently empty. Personal blocking and Google's AI Overview
filter work independently of community entries.

## Entry format

Both files are flat JSON arrays of objects:

```json
[
  {
    "id": "UCxxxxxxxxxxxxxxxxxxxxxx",
    "name": "Channel Name",
    "added": "2026-07-16",
    "reason": "Fully AI-generated narration + stock footage farm"
  }
]
```

| Field | Required | Format |
|---|---|---|
| `id` | yes | Video: 11-char YouTube ID. Channel: canonical `UC…` ID or `@handle`. |
| `name` | no | Video title or channel name, for human review (max 100 chars). |
| `added` | yes | `YYYY-MM-DD` — the date the entry was merged. |
| `reason` | no | One line on why it's AI slop (max 300 chars). |

The extension only uses `id`; the rest exists so the list stays reviewable and
auditable — anyone can see what was added, when, and why.

## How entries get here

1. Community reporting is **off by default**. If a user explicitly enables
   **Share my future block reports** in Settings, later blocks can send a
   **pseudonymous** report containing `{videoId, channelId, channelName, scope,
   installId}` when available. A channel report also includes its current video.
   Opt-in does not upload existing local blocks; turning sharing off stops
   future reports. Local blocking does not depend on sharing.
2. A random installation UUID is generated locally on installation and is sent
   only with opted-in future reports; there is no automatic install telemetry.
   The backend derives a SHA-256 contributor ID for deduplication, limits,
   moderation, and counts of active/eligible installation identifiers. These are
   not verified people or distinct-user counts. Reinstallation, local data reset,
   or a new client-supplied ID can evade an ignore rule. Full browsing, search and
   watch histories are not uploaded.
3. A GitHub Actions workflow in the private `raduvlad92/AI-Slop-Review` repository
   uses the `ASB_API_URL` variable and `ASB_STATS_KEY` secret to request the
   administrator-protected, read-only `GET /review` endpoint. It writes aggregate
   `REVIEW.md` and `review.json` snapshots with its ephemeral, repository-scoped
   token. This release mode does not store a persistent GitHub PAT in the Worker.
   The snapshots include aggregate active/eligible installation-ID and ignored
   registry counts, never raw UUIDs, hashes, per-contributor histories, or reasons.
   The maintainer reviews candidate videos/channels from these snapshots.
4. Entries that are clearly AI slop get merged into these JSON files via a
   normal pull request.

The separate private local administration view can show each hashed contributor's
retained report history/counts. A moderator can mark reports pending, useful, or
false positive and ignore/resume that ID's reports, with an optional reason.
Ignoring excludes past and future reports from community review without affecting
the installation's local blocks or list sync. It does not automatically remove
entries already published in these lists; removals still require review and a PR.

Raw UUID-linked reports and their review statuses/history expire after 90 days.
The minimal ignored-ID hash/reason/update record remains until manual resume or
deletion so an ignore can outlast its reports. Private GitHub snapshots contain
aggregates only. Historical aggregate snapshots and
public curated lists/Git history can remain indefinitely. Disabling sharing or
removing a personal block does not retract a report already received. See the
[privacy policy](https://aislopblocker-api.radu-vlad-92.workers.dev/privacy) and
[backend documentation](../backend/README.md) for retention and data handling.

## Why merging is manual — on purpose

There is deliberately **no automatic promotion** from submissions to this
list. A popular submission is a signal, not a verdict: automatic merging would
make the list trivially abusable — coordinated brigading could get a channel
someone simply dislikes blocked for every user of the extension. Manual review
is the abuse defense. Please don't open issues asking for auto-merge; it's a
design decision, not a missing feature.

## Opening a PR directly

You can also propose additions/removals by PR against these files:

- Keep the files valid JSON in the format above.
- Keep entries sorted by `added` date (newest last) — it makes diffs reviewable.
- In the PR description, link the video/channel and briefly say why it's
  AI-generated content.
- If you're a creator who believes you were wrongly listed, open a removal PR
  or issue for maintainer review.

A GitHub Actions check validates the JSON structure and identifiers when these
JSON files change in a PR or on `main`.
