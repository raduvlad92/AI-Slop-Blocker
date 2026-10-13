# Chrome Web Store listing draft

These fields describe verified release ZIP 0.1.1. The production backend and public policy are live and checked, and the private review workflow completed its first successful run. Live unpacked desktop Chrome testing, developer-account/dashboard checks, upload and publication remain pending.

## Name

AI Slop Blocker

## Short description

Hide Google AI Overviews and manually block unwanted YouTube videos, channels, and Shorts. Free and local-first.

## Detailed description

Choose what stays in your search results and YouTube feed.

AI Slop Blocker hides Google's AI Overview answer boxes and gives you manual controls to block YouTube videos and channels you consider AI slop. You make the decision: the extension does not use an AI detector or automatically classify ordinary videos or search results.

- Google Search: hide positively identified, English-labelled AI Overview answer boxes. Ordinary search results stay visible.
- YouTube: use the AI Slop button on watch pages and Shorts to block a video or its channel. An optional thumbnail button makes blocking available directly from supported feeds, searches, and recommendations.
- Playback controls: choose a blocked overlay, redirect to the YouTube homepage, skip to the next video, or play a sidebar recommendation.
- Personal lists: manage blocked videos and channels in Settings. Your choices are stored on this device.
- Community lists: public lists are reviewed by a human and synced periodically. Reports never automatically become community blocks. The community lists are currently empty; your personal blocks and Google filtering work independently.

Local-first, with optional community reports

No account or payment is required. Settings, personal blocks, statistics, and cached lists remain in local extension storage. Sharing reports is off by default. You can explicitly enable "Share my future block reports" in Settings and turn it off again at any time.

When sharing is enabled, a block report contains the selected video's ID, channel ID/name when available, block scope, and a random installation ID generated on first opt-in for deduplication and rate limits. A channel report also includes the current video when available. These pseudonymous reports help a human review candidates for the public community lists. They do not include your account or full watch history. Raw UUID-linked reports expire after 90 days; historical aggregate review snapshots and public curated lists can remain. Turning sharing off stops future reports without retracting earlier ones.

The extension downloads public community lists from GitHub and may fetch public YouTube metadata for channels already on a block list, without account cookies, to match channel IDs and handles. Reporting being off does not disable these public metadata/list requests.

Compatibility and limits

For desktop Chrome. Google AI Overview detection currently supports English labels. Google and YouTube can change their page layouts, which can affect filtering. There is no automatic AI classification of ordinary content. Channel blocks can also retain the video from which you made the block; remove both entries in Settings to restore it. Time-saved statistics are estimates.

Privacy policy: https://aislopblocker-api.radu-vlad-92.workers.dev/privacy

Support: contact@deletecookies.dev

Source and community-list review: https://github.com/raduvlad92/AI-Slop-Blocker

## Public links and contact

- Privacy policy: `https://aislopblocker-api.radu-vlad-92.workers.dev/privacy` — live and verified against the packaged policy.
- Support email: `contact@deletecookies.dev`.
- Homepage/source: `https://github.com/raduvlad92/AI-Slop-Blocker`.
- Support/issues: `https://github.com/raduvlad92/AI-Slop-Blocker/issues`.
- Suggested category: Productivity; confirm the categories available in the dashboard.
- Listing language: English.
- Price: Free.

## Single purpose

Help users hide unwanted AI Overview answers and manually selected YouTube videos/channels using local block lists and human-curated community lists.
