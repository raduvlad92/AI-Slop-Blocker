# Chrome Web Store submission preparation

Release 0.1.2's tests, contributor migration/deployment and live moderation checks, updated policy equality, regenerated Settings screenshot, ZIP, real private admin view, and updated GitHub review run/output are verified. Developer account registration, dashboard fields, upload and store review status remain unverified. Complete the user's unpacked desktop Chrome 0.1.2 retest before submitting.

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
| `store/screenshot-settings-1280x800.png` | Listing screenshot | 1280 × 800 actual updated Options fixture capture, regenerated/viewed for 0.1.2; sharing clearly off |

The promotional tile communicates the brand. The regenerated Settings screenshot uses the actual updated Options page rendered with a fresh-install Chrome API fixture and was visually checked. It does not establish a live installed-extension test on Google/YouTube. The artwork was drawn as SVG and rasterized with browser canvas. No Chrome or YouTube UI screenshot was invented.

To regenerate the artwork, serve the repository locally, open `store/artwork-preview.html`, and use Download PNG exports. Keep the final promotional PNG opaque. PNGs are the packaged/store assets; SVGs are editable sources.

## Privacy practices fields

Use the single-purpose and public listing text from `store/LISTING.md`. Match the final release manifest exactly when entering permission justifications.

| Permission or host | Justification |
| --- | --- |
| `storage` | Store a local random installation UUID, personal block lists, settings, explicit reporting consent, local counters/events, cached community lists, and channel identity mappings on this device. The UUID is sent only with opted-in future block reports. |
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
- Identifiers: installation UUID generated/stored locally at install, repaired if missing/invalid on update, and transmitted only with opted-in future reports. The server derives a SHA-256 contributor ID for private history/moderation and an ignored-ID registry. The existing temporary IP-derived abuse key is separate. Check current dashboard identifier definitions and disclose conservatively; a hashed ID is still linked data.
- Moderation records: selected-report statuses/history retained for 90 days, plus a minimal hashed ignored-ID/reason/update record retained until manual resume/deletion. Private GitHub snapshots contain aggregate counts, never raw UUIDs/hashes, individual histories, or reasons.
- Installation/country metrics: use Chrome Web Store-provided aggregates if published. The extension adds no install beacon or email/IP/country payload fields. Do not treat contributor counts as a count of all installers or verified people.

Do not declare financial/payment, health, authentication credentials, location tracking, or personal communications: the extension has no such feature. Confirm the final policy also covers GitHub/YouTube network requests, optional reports, the review workflow, retention/deletion, and support contact. Certify limited-use statements only after the release's actual behavior and operator practices match them; data is not sold or used for advertising, lending, or unrelated purposes.

Public policy URL: **https://aislopblocker-api.radu-vlad-92.workers.dev/privacy**; the October 14 update is live and verified byte-identical to both local copies and the packaged policy. Public contact: **contact@deletecookies.dev**.

The release review workflow is configured in the private `raduvlad92/AI-Slop-Review` GitHub repository. Its `ASB_API_URL` variable selects the reporting service and its `ASB_STATS_KEY` Actions secret authenticates read-only `GET /review`. The job commits aggregate snapshots with an ephemeral, repository-scoped token; no persistent GitHub PAT is kept in the Worker. Updated snapshots include 90-day active/eligible installation-ID counts and the persistent ignored-registry count, never raw UUIDs/hashes, histories, or reasons. Historical aggregates can remain. [Run 38489277906](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38489277906) succeeded, and the actual Markdown/JSON snapshot output was checked for the new aggregate format and exclusion of individual identifiers/histories.

The maintainer's separate private view is launched with `npm run review:admin` at `http://127.0.0.1:8768/`. Its Node process uses the configured credential outside the repository; the key is never pasted into a browser, included in URLs, or stored in browser storage. It shows hashed contributors and retained report history/counts, with pending/useful/false-positive and Ignore reports/Resume reports controls and an optional reason. Synthetic UI/security checks and the real production read-only view passed; no admin secret/browser Authorization header or console errors were observed, and real reports were untouched. It is not part of the public extension package.

## Reviewer instructions draft

1. Install the extension in desktop Chrome. No login, payment, API key, or external account is required for personal blocking and Google filtering.
2. Open the extension popup and Settings. Find **Optional community reports**. **Share my future block reports** starts unchecked, and Settings says **Sharing is off. New blocks stay on this device.** Changing filtering/playback settings does not enable sharing.
3. With sharing off, visit a YouTube watch page or a Short. Use the AI Slop button to block a chosen video or channel. Check that the personal block appears in Settings and is enforced on supported cards/playback. The optional thumbnail button can be enabled from Settings.
4. To restore a personally blocked video, remove its video entry. If you blocked the channel, also remove the channel entry. Community matches are separately curated; there is no automatic report promotion or permanent community allowlist in this release.
5. Test an English Google Search page that currently contains an AI Overview. Toggle the Google filter and confirm the answer box is hidden/restored without hiding ordinary search results. A search with no AI Overview will have nothing to hide.
6. Inspect the reporting disclosure. The installation UUID is generated locally at install, stays stable across restarts/consent toggles, and is not uploaded on install or opt-in. Enabling **Share my future block reports** authorizes future reports only, with no replay of earlier blocks. Reports contain `{videoId, channelId, channelName, scope, installId}`. A hashed contributor ID supports private retained-report review and ignore/resume; IDs are installations, not verified people. Reporting remains off by default. Human review and a PR are required for public community entries.
7. The community lists are currently empty. Their sync status/counts can be inspected in Settings; no claimed starter protection is expected. Public metadata/list downloads can still occur while report sharing is off.

For review testing of opt-in reports, use the configured production endpoint and an intentional test choice. Live 0.1.2 checks confirmed status changes, exclusion of ignored historical votes, ignored future submissions without insertion, and resumed eligibility. Synthetic test reports/rules were removed and existing real reports preserved. Reports are best-effort; the sharing status indicates consent rather than delivery confirmation. Report/review history expires at 90 days; the minimal ignored-ID registry remains until manual resume/deletion. Ignoring never disables local blocking/sync or automatically removes published entries.

## Submission checklist

- [x] Release ZIP 0.1.2 contains the final manifest, icons, updated policy, and configured reporting host; tests/resources/CRC/secret exclusion checked.
- [x] Icon exports, editable sources, and the 440×280 promotional PNG are prepared and visually/dimensionally checked.
- [x] October 14 public policy update is deployed and byte-identical to the packaged policy.
- [x] Contributor migration/private backfill, admin authentication and live status/ignore/resume behavior verified; real reports preserved, synthetic records/rules removed. Retention/cleanup regressions pass; Worker holds `STATS_KEY` and no GitHub token.
- [x] Updated private Actions run/output verified: aggregate active/eligible/ignored counts without UUIDs, hashes, individual histories, or reasons.
- [x] Five private helper security checks and eight synthetic admin UI checks pass, including credential exclusion from the browser, CSRF/Host and no-redirect protection; install/consent regressions cause no report upload.
- [x] Real production read-only admin UI checked with contributor/history navigation, no exposed admin credential/browser Authorization header or console errors, and real reports untouched.
- [ ] User completes the unpacked desktop Chrome 0.1.2 retest on live Google/YouTube.
- [x] Settings screenshot regenerated/viewed from updated actual Options UI using a fresh-install Chrome API fixture at 1280×800; sharing off, no invented Chrome/YouTube UI.
- [x] Listing draft states English Google support, manual classification, desktop compatibility, optional reporting, and empty community lists.
- [ ] Developer account registration, verified contact, and any dashboard-specific declarations are completed by the owner.
- [ ] Privacy practices and permission fields match the exact ZIP being submitted.
- [ ] Distribution choice and manual publishing controls are selected by the owner.
- [ ] Submission/upload/publishing authorization is explicitly confirmed before those external actions.

Verified package: `releases/AI-Slop-Blocker-0.1.2.zip` — 19 extension files,
47,020 bytes. Archive CRC, required resources, policy equality, endpoint/permissions,
icons, and admin/backend/scripts/tests/secret exclusion were verified. SHA-256:
`46a6a977d37a691632e1ed0b437dcdf0ef1bf231e417f05f06e48e3470f497ed`.
Validation passed 118 Node tests, 12 extension browser fixtures, eight synthetic
admin browser checks, five helper security checks, the real admin read-only view,
and updated private GitHub workflow/output inspection. The user's unpacked Chrome
0.1.2 retest remains separate and pending.

## Official references

Google documents required icon/promotional/screenshot assets in [Supplying Images](https://developer.chrome.com/docs/webstore/images/). The privacy dashboard requires purpose, permissions, remote-code and data-use declarations in [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/). Local handling is still data handling; disclosures and HTTPS apply according to the [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/). These references were checked on 2026-10-13; inspect current dashboard prompts before submission.
