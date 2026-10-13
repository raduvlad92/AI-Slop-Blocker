# Chrome Web Store submission preparation

Store artwork, a Settings screenshot, consent controls, and listing/privacy materials are prepared. Production backend/policy deployment and release ZIP 0.1.1 are verified. The private review workflow completed its first successful run. Developer account registration, verification, dashboard fields, upload and store review status remain unverified. Complete the user's desktop Chrome test before submitting.

## Assets

| File | Use | Verified format |
| --- | --- | --- |
| `extension/icons/icon-16.png` | Small toolbar icon | 16 × 16, transparent PNG |
| `extension/icons/icon-32.png` | High-density toolbar icon | 32 × 32, transparent PNG |
| `extension/icons/icon-48.png` | Extension management icon | 48 × 48, transparent PNG |
| `extension/icons/icon-128.png` | Packaged/store icon | 128 × 128, 96 × 96 artwork with 16px transparent padding |
| `extension/icons/icon.svg` | Editable icon source | Self-contained SVG; no external fonts or images |
| `store/promo-440x280.png` | Small promotional tile | 440 × 280, opaque PNG |
| `store/promo-440x280.svg` | Editable promotional source | Self-contained SVG |
| `store/screenshot-settings-1280x800.png` | Listing screenshot | 1280 × 800; actual Options HTML/JavaScript captured with a fresh-install Chrome API fixture |

The promotional tile communicates the brand. The Settings screenshot shows the actual Options page rendered with a fresh-install Chrome API fixture; it does not establish a live installed-extension test on Google/YouTube. The artwork was drawn as SVG and rasterized with browser canvas. No Chrome or YouTube UI screenshot was invented.

To regenerate the artwork, serve the repository locally, open `store/artwork-preview.html`, and use Download PNG exports. Keep the final promotional PNG opaque. PNGs are the packaged/store assets; SVGs are editable sources.

## Privacy practices fields

Use the single-purpose and public listing text from `store/LISTING.md`. Match the final release manifest exactly when entering permission justifications.

| Permission or host | Justification |
| --- | --- |
| `storage` | Store personal block lists, settings, explicit reporting consent, local counters/events, cached community lists, and channel identity mappings on this device. |
| `alarms` | Refresh public community lists every six hours and update the local daily badge. |
| Google search pages in the manifest | Inspect search-page structure to hide English-labelled AI Overview containers while preserving ordinary results. |
| YouTube pages in the manifest | Add manual block controls, filter blocked videos/channels, protect blocked playback including Shorts, and fetch public metadata only for already blocked channels to match handles with canonical IDs. |
| Public GitHub raw blocklist host/path in the manifest | Download the two public, manually reviewed JSON lists. These downloads are data, not executable code. |
| Configured reporting host, if included | Send selected block reports over HTTPS only after the user explicitly enables future report sharing. Local blocking works with sharing off. |

Remote code: **No.** All executable extension JavaScript is packaged in the ZIP. Downloaded JSON lists supply identifiers. Fetched YouTube HTML is read as text to extract channel metadata; its scripts are not executed. No downloaded JavaScript is evaluated.

Data handling must be disclosed even when storage/processing is local. Do not select "no user data" simply because reporting is off by default. The extension processes:

- Website content: video/channel identifiers and channel names, page structure, and public channel metadata.
- Web browsing activity: the current supported page/video identity needed for blocking; selected IDs are included in reports only after consent. There is no full watch-history collection.
- User activity: local block/filter events, block choices, and statistics; selected block actions are reported only after consent.
- Identifiers: random installation UUID in opt-in reports; the reporting service also uses a temporary IP-derived key for abuse prevention. Check the dashboard's current personally identifiable information/identifier definitions and disclose these conservatively. Do not describe the extension as having no identifiers.

Do not declare financial/payment, health, authentication credentials, location tracking, or personal communications: the extension has no such feature. Confirm the final policy also covers GitHub/YouTube network requests, optional reports, the review workflow, retention/deletion, and support contact. Certify limited-use statements only after the release's actual behavior and operator practices match them; data is not sold or used for advertising, lending, or unrelated purposes.

Public policy URL: **https://aislopblocker-api.radu-vlad-92.workers.dev/privacy**; live and verified byte-identical to the packaged policy. Public contact: **contact@deletecookies.dev**.

The release review workflow is configured in the private `raduvlad92/AI-Slop-Review` GitHub repository. Its `ASB_API_URL` variable selects the reporting service and its `ASB_STATS_KEY` Actions secret authenticates read-only `GET /review`. The job commits aggregate snapshots with an ephemeral, repository-scoped token. No persistent GitHub personal access token is kept in the Worker for this release mode. Raw UUID-linked reports expire after 90 days; review snapshots exclude raw UUIDs but historical aggregates can remain. [Run 38476767542](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38476767542) completed successfully on 2026-10-14; the private run requires authorized repository access.

## Reviewer instructions draft

1. Install the extension in desktop Chrome. No login, payment, API key, or external account is required for personal blocking and Google filtering.
2. Open the extension popup and Settings. Find **Optional community reports**. **Share my future block reports** starts unchecked, and Settings says **Sharing is off. New blocks stay on this device.** Changing filtering/playback settings does not enable sharing.
3. With sharing off, visit a YouTube watch page or a Short. Use the AI Slop button to block a chosen video or channel. Check that the personal block appears in Settings and is enforced on supported cards/playback. The optional thumbnail button can be enabled from Settings.
4. To restore a personally blocked video, remove its video entry. If you blocked the channel, also remove the channel entry. Community matches are separately curated; there is no automatic report promotion or permanent community allowlist in this release.
5. Test an English Google Search page that currently contains an AI Overview. Toggle the Google filter and confirm the answer box is hidden/restored without hiding ordinary search results. A search with no AI Overview will have nothing to hide.
6. Inspect the reporting disclosure. Enabling **Share my future block reports** explicitly authorizes future reports only; it does not upload existing personal lists. Turning it off stops future report sharing. Reports contain `{videoId, channelId, channelName, scope, installId}`; the installation ID is random and supports deduplication/rate limits. Human review is required before an entry reaches public community lists.
7. The community lists are currently empty. Their sync status/counts can be inspected in Settings; no claimed starter protection is expected. Public metadata/list downloads can still occur while report sharing is off.

For review testing of opt-in network reports, use the configured production endpoint and an intentional test choice. Live smoke checks confirmed accepted report storage, duplicate prevention, and authenticated aggregate output without raw UUIDs. The test report was removed after verification. Reports are best-effort; the sharing status indicates consent rather than delivery confirmation.

## Submission checklist

- [x] Release ZIP 0.1.1 contains the release manifest and PNG icons, with the verified production reporting host.
- [x] Icon exports, editable sources, and the 440×280 promotional PNG are prepared and visually/dimensionally checked.
- [x] Public privacy policy URL loads without login and is byte-identical to the packaged policy.
- [x] Production reporting endpoint/database, abuse-limit bindings, administrator access, and daily cleanup configuration verified; Worker holds `STATS_KEY` and no GitHub token.
- [x] First private review Actions run completed successfully through the authenticated aggregate endpoint: run `38476767542`.
- [ ] User has completed the requested unpacked desktop Chrome test on live Google/YouTube.
- [x] Settings screenshot is prepared from actual Options UI with a fresh-install Chrome API fixture at 1280×800; no invented Chrome/YouTube UI.
- [x] Listing draft states English Google support, manual classification, desktop compatibility, optional reporting, and empty community lists.
- [ ] Developer account registration, verified contact, and any dashboard-specific declarations are completed by the owner.
- [ ] Privacy practices and permission fields match the exact ZIP being submitted.
- [ ] Distribution choice and manual publishing controls are selected by the owner.
- [ ] Submission/upload/publishing authorization is explicitly confirmed before those external actions.

Release package: `releases/AI-Slop-Blocker-0.1.1.zip` — 19 extension files,
45,892 bytes. Archive CRC, required resources, policy equality, endpoint/permissions,
icons, and backend-secret exclusion were verified. SHA-256:
`7be53ce03e657defa7389afc5e994395a3e546186dacf3585aaaf0e76505b8b8`.
The release validation passed 82 Node tests and 12 controlled browser fixtures;
the user's real unpacked Chrome test remains a separate pending step.

## Official references

Google documents required icon/promotional/screenshot assets in [Supplying Images](https://developer.chrome.com/docs/webstore/images/). The privacy dashboard requires purpose, permissions, remote-code and data-use declarations in [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/). Local handling is still data handling; disclosures and HTTPS apply according to the [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/). These references were checked on 2026-10-13; inspect current dashboard prompts before submission.
