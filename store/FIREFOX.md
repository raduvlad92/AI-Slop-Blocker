# Firefox and Zen release preparation — 0.2.0

The Firefox package targets desktop Firefox 142+ and works in Zen through its
Firefox WebExtensions support. Use `npm run package`; the Firefox manifest uses
an ES-module background event page and the stable add-on ID
`ai-slop-blocker@deletecookies.dev`. Keep that ID for future releases.

For temporary testing, load `releases/firefox/manifest.json` through
`about:debugging#/runtime/this-firefox` in either browser. Temporary installs end
at restart. Normal Firefox release/beta installation requires Mozilla signing,
even for unlisted/self-distributed packages. No signing or AMO submission has
been performed by this change.

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

## Listed submission prepared November 11

The user has authorized public Firefox marketplace publication. CI for PR #1 is
successful, the exact unsigned Firefox package passes Mozilla lint, and the
updated public privacy policy is deployed and byte-identical to the package.
The public AMO lookup for `ai-slop-blocker@deletecookies.dev` currently returns
404. No upload, signing, submission or public availability is claimed.

The developer dashboard requires Mozilla sign-in behind a CAPTCHA; no Mozilla
API issuer/secret is configured locally. Secure credential inputs are required
for official API submission. Do not put signing credentials in Git or chat.

`amo-metadata.json` prepares a **listed**, desktop-Firefox submission. It starts
with `is_disabled: true` so policy/icon/preview metadata can be completed before
publishing is enabled. The initial release is marked experimental. The draft
uses Mozilla's `all-rights-reserved` choice because the repository has no
open-source license grant; this preserves existing rights rather than choosing
a new open-source license. `amo-policy.json` holds the actual published policy.
Use `extension/icons/icon-128.png` and the actual Settings screenshot for assets.

After authentication, submit with `web-ext sign --channel listed` and the prepared
metadata, set the policy through the documented `eula_policy` API, attach the
icon/preview, then enable listing publication. Check the actual version's file
status and anonymous marketplace install link; an upload or pending review is
not proof of public availability. Preserve the upload UUID if submission status
is ambiguous rather than blindly re-uploading.

API references: [listed add-on creation](https://mozilla.github.io/addons-server/topics/api/addons.html#create),
[version license/compatibility](https://mozilla.github.io/addons-server/topics/api/addons.html#version-create),
[privacy policy](https://mozilla.github.io/addons-server/topics/api/addons.html#eula-and-privacy-policy-edit),
[license choices](https://mozilla.github.io/addons-server/topics/api/licenses.html).
