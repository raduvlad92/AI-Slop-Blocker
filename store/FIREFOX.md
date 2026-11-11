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

- Deploy the November 11 policy and verify public/packaged equality.
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
