# Firefox and Zen release preparation — 0.2.0

The Firefox package targets desktop Firefox 142+ and works in Zen through its
Firefox WebExtensions support. Use `npm run package`; the Firefox manifest uses
an ES-module background event page and the stable add-on ID
`ai-slop-blocker@deletecookies.dev`. Keep that ID for future releases.

For temporary testing, load `releases/firefox/manifest.json` through
`about:debugging#/runtime/this-firefox` in either browser. Temporary installs end
at restart. Normal Firefox release/beta installation requires Mozilla signing,
even for unlisted/self-distributed packages. Firefox version 0.2.0 is submitted to AMO and awaiting Mozilla review.
No public signed installation has been verified yet.

The generated manifest declares no mandatory report-data collection and declares
optional `browsingActivity`, `websiteContent`, `websiteActivity`, and
`personallyIdentifyingInfo` for selected report IDs/names, block actions and the
installation UUID. Settings requests these native permissions in response to the
user enabling sharing. Native permission alone never enables the application's
reporting choice. Removal disables sharing; every attempt checks permissions.
Public metadata/list requests remain described in the privacy policy.

Before signing/submission:

- [x] November 11 policy deployed and public/packaged equality verified.
- Complete Mozilla developer-account setup and review the exact package's data
  declarations, permissions, policy, support details and distribution choice.
- Retest live Google/YouTube/Shorts, native permission grant/rejection/revocation,
  and actual signed-package installation, update and restart persistence in both browsers.
- Submit the exact Firefox archive through AMO for signing (listed or unlisted).
  Public store submission/publication is an owner-account release step.

Development checks include Mozilla lint, 16 DOM regressions in Firefox, and
installed-extension local-fixture checks in Firefox and native Zen. These do not
establish signed distribution or current live-site compatibility.

Official references: [background environments](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background),
[Mozilla data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/),
[signing/distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/),
[Zen extensions](https://docs.zen-browser.app/user-manual/extensions).

## Listed submission — November 11

Mozilla accepted the secure API credentials and the listed 0.2.0 submission:

- Add-on **3124801**, GUID `ai-slop-blocker@deletecookies.dev`.
- Version **6692417**, file **5236506**, preview **447925**.
- Add-on status **nominated**; version file status **unreviewed**.
- Add-on and version are enabled; the release is marked experimental.
- The privacy policy, icon and Settings screenshot/caption are attached.
- [Developer version](https://addons.mozilla.org/en-US/developers/addon/ai-slop-blocker1/versions/6692417).
- [Intended public listing](https://addons.mozilla.org/en-US/firefox/addon/ai-slop-blocker1/).

Anonymous verification currently returns API 401 and a public page with no
install link. This is an accepted submission awaiting Mozilla review, **not
verified marketplace availability**. Do not re-upload 0.2.0; retain the existing
version/upload identity. After approval, verify the anonymous listing and signed
download, then complete signed-package installation/update/restart checks.
Machine-readable evidence is in `AMO-SUBMISSION.json`. Credentials were used only
inside a temporary local publisher process and were never added to Git.

The November 11 public policy is deployed and byte-identical to the package.
`amo-policy.json` contains the policy text attached to AMO. `amo-metadata.json`
is the initial-create template; its disabled flag is a staging safeguard, not
the current AMO state. Initial creation disabled the version as well as the
add-on; both were explicitly enabled after the policy and assets were attached.
For future releases, inspect the existing add-on/version state before applying
metadata. Do not use the initial-create payload blindly against a live listing.

The license is Mozilla's `all-rights-reserved` choice because the repository has
no open-source license grant. This preserves existing rights rather than
choosing a new open-source license.

API references: [listed add-on creation](https://mozilla.github.io/addons-server/topics/api/addons.html#create),
[version license/compatibility](https://mozilla.github.io/addons-server/topics/api/addons.html#version-create),
[privacy policy](https://mozilla.github.io/addons-server/topics/api/addons.html#eula-and-privacy-policy-edit),
[license choices](https://mozilla.github.io/addons-server/topics/api/licenses.html).
