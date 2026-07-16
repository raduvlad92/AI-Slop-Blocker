# Contributing to the community blocklist

These two files are what every AI Slop Blocker install fetches directly from
GitHub raw and applies alongside each user's personal list:

- `videos.json` — a flat JSON array of YouTube video IDs (11 characters)
- `channels.json` — a flat JSON array of channel identifiers, either canonical
  `UC…` IDs or `@handles`

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

- Keep the files valid JSON: a flat array of strings, nothing else.
- One line per ID, keep the array sorted (makes diffs reviewable).
- In the PR description, link the video/channel and briefly say why it's
  AI-generated content (e.g. synthetic voiceover + stock footage farm,
  AI-generated thumbnails/scripts at scale).
- Removals are taken seriously — if you're a creator who believes you were
  wrongly listed, open a PR or issue and it will be reviewed promptly.

A GitHub Actions check validates the JSON structure on every PR so a malformed
merge can never break the extension's fetch/parse.
