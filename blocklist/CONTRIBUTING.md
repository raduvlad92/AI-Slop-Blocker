# Contributing to the community blocklist

These two files are what every AI Slop Blocker install fetches directly from
GitHub raw and applies alongside each user's personal list:

- `videos.json` — blocked YouTube videos
- `channels.json` — blocked YouTube channels

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

1. When someone blocks a video or channel in the extension, an **anonymous**
   submission ({videoId, channelId, scope} + a random install UUID) is sent to
   the backend. No accounts, no personal data.
2. I (Vlad) periodically review the top submissions via the backend's `/stats`
   endpoint — what's being reported most, by how many distinct installs.
3. Entries that are clearly AI slop get merged into these JSON files via a
   normal pull request.

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
- Removals are taken seriously — if you're a creator who believes you were
  wrongly listed, open a PR or issue and it will be reviewed promptly.

A GitHub Actions check validates the JSON structure on every PR so a malformed
merge can never break the extension's fetch/parse.
