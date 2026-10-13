# Review implementation plan

The current batch implements review items 1–5. Remaining items are explicitly deferred.

## Current batch

- [x] 1. Repair thumbnail actions and retry watch overlays for delayed/replaced players.
- [x] 2. Serialize personal blocks, counters, events and removals through the background worker.
- [x] 3. Hide only self-contained Google AI Overview content; preserve all organic results.
- [x] 4. Require administrator credentials for stats/digest and add independent reporting limits.
- [x] 5. Resolve channel IDs/handle aliases, anchor blocks to canonical creators, and protect Shorts playback.

Verification: focused Node regressions, real-browser fixtures using the actual extension scripts, and a Cloudflare Worker build dry run. Fixtures mock reports and channel requests; these checks do not establish a production deployment or full live YouTube compatibility.

## Parked for later

- **6. Recovery from mistakes:** Undo, Watch once, Always allow, and clear personal/community blocking reasons. The existing behavior where blocking a channel also blocks its current video remains; removing that channel can leave the video blocked.
- **7. Reporting/privacy controls:** local-only mode, exact reporting disclosures, retention/deletion rules and a linked privacy policy.
- **8. Release setup:** production Worker URL/D1 ID, icon assets, reviewed starter community lists, and deployment/Web Store verification.
- **List management:** export/import, search, readable video titles and links.
- **Sync status:** show failed updates and stale cached lists clearly.
- **Statistics:** distinguish manual block actions from hidden content and make estimated time savings explicit.
- **Accessibility:** menu focus, Escape dismissal and accessible toast feedback.
- **Broader automation:** CI for extension/backend changes and a larger live navigation/markup compatibility matrix. Focused regressions for this batch are included now.

Manual community curation, no accounts and no AI-detection heuristics remain the product boundaries.
