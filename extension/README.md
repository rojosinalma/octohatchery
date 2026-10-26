# OctoHatchery browser extension

See your OctoHatchery's jobs from the browser toolbar. You see what runs now and where, what waits in the queue, and how the last jobs ended. The extension also sends an alert when a job starts, succeeds or fails, and keeps counters on the toolbar icon until you open the popup.

It works with any OctoHatchery: you enter the URL of your own dashboard in the options. It talks to that address only.

## Install

There is no store listing yet. Build the extension, then load it unpacked.

```sh
bin/build-extension
```

This writes two zips to `dist/extension/`. The file names have no version in them, so a new build replaces the old one in place:

- `octohatchery-extension-chrome.zip` holds one folder, `octohatchery-extension/`.
- `octohatchery-extension-firefox.zip` holds the files at its root.

**Chrome, Edge, Brave and other Chromium browsers**

1. Unzip `octohatchery-extension-chrome.zip`. Keep the `octohatchery-extension` folder in a fixed place.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `octohatchery-extension` folder.

To update, unzip the new build over the same folder, then click the reload arrow on the extension's card. You do not need to remove the extension or load it again, and it keeps its settings.

**Signed .crx**

`bin/build-extension --crx` also writes `dist/extension/octohatchery-extension.crx`, signed with your own key. Google Chrome installs a `.crx` from outside the Chrome Web Store only when a policy allows it. Set `ExtensionInstallAllowlist` to the extension ID and `ExtensionInstallSources` to the place the file comes from, or use `ExtensionSettings`. Without such a policy it refuses the file with `CRX_REQUIRED_PROOF_MISSING`. Chromium installs it in developer mode when you drop it on `chrome://extensions`. For a normal Chrome, load the folder unpacked as described above.

The signing key is `.git/info/extension-key.pem` (or the file in `EXTENSION_KEY`). The first `--crx` build creates it. Git does not track it, so keep a copy. The key fixes the extension ID: the unpacked build carries its public key too, so the folder and the `.crx` get the same ID. A new key means a new extension to the browser, which starts with empty settings.

**Firefox 128 or newer**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `octohatchery-extension-firefox.zip`.

Firefox removes a temporary add-on when it closes. A signed build comes with the store release.

## Set up

1. Open the extension's options. The popup has a gear button, or you can right-click the icon and choose **Options**.
2. Enter your dashboard URL, for example `https://hatchery.example.com`, and click **Connect**.
3. The browser asks you to let the extension read that site. Allow it. The extension asks for this one site only, never for all sites.
4. The options page tests the connection and shows the hatchery's version.

The extension uses the address's origin only (scheme, host and port), because the dashboard runs at the site root.

### Sign-in

OctoHatchery has no login of its own. It sits behind a reverse proxy with single sign-on, such as Authentik, Authelia, Cloudflare Access or OAuth2 Proxy. The extension sends the browser's cookies for your hatchery's site with each request. So when you can open the dashboard in a tab, the extension can read it too.

When the proxy asks for a new sign-in, the toolbar shows an orange `!`. The popup then shows a **Sign in** button that opens the dashboard. Sign in there, and the next poll works again.

If the proxy lets a request through only with a header or a token (and not with the browser's cookies), the extension cannot sign in. It does not store credentials.

## What it shows

**Popup**

- Four tiles: jobs running now, jobs queued, and jobs that succeeded and failed since you last opened the popup. Each tile opens the matching filtered list on the dashboard.
- **Running**: each job with its repo, host and template, and the time since it started.
- **Queued**: the jobs that wait longest, with their waiting time.
- **Recent**: the last finished jobs with their result.
- **Hosts**: each node, online or not, with its busy slots of all slots. An orange border means every slot on that host is busy.
- Links to the Overview, Jobs, Failed and Hosts pages.

A job name opens its page on the dashboard. The GitHub icon opens the run on GitHub.

While the popup is open, it follows the hatchery's live event stream and updates within a second of a change. The dot in the header is green while the stream is up.

**Toolbar counters**

You choose the counters in the options:

| Counter | Counts |
|---|---|
| Running: Live count | The jobs running now. It goes down when they end. Opening the popup does not reset it. |
| Running: Started | The jobs that started since you last opened the popup. |
| Running: Both | Both of the counters above. |
| Succeeded | The jobs that succeeded since you last opened the popup. |
| Failed | The jobs that failed since you last opened the popup. |

With **Reset when the popup opens** on, opening the popup sets the started, succeeded and failed counters to zero. The popup still shows the values they had. With it off, they keep counting until you click **Clear the counters** in the popup.

Two styles:

- **Drawn icon**: every counter above zero gets a coloured tile on the icon. Blue is running, aqua is started, green is succeeded and red is failed. One counter fills the icon, two split it, and three or four take a quarter each.
- **Badge**: the logo stays, and a badge shows one count: failed first, then succeeded, then running.

The tooltip on the icon always lists every counter. A `?` badge means no URL is set. An orange `!` badge means the extension is signed out, has no access to the site, or gets no answer.

**Alerts**

**Notifications** turns every alert on or off at once. The counters and the popup work either way. You turn each alert on or off: a job starts running, a job succeeds, a job fails. You can also limit alerts to some repos. The counters always count every repo. A click on an alert opens the job's page. When four or more jobs of one kind change in the same poll, you get one alert that lists them.

What counts as what:

- **Failed**: the result is `failure` or `timed_out`, and `cancelled` when **Count cancelled jobs as failed** is on (the default, like the dashboard's Failed filter).
- **Succeeded**: the result is `success`.
- Any other result (`skipped`, `neutral`, or a result GitHub has not reported yet) counts as nothing and sends no alert. When the real result arrives later, it counts then.

The first poll after you connect only records the current state, so you do not get alerts for old jobs.

## Appearance

By default the popup and the options page use the same skin, palette and mode as the dashboard. They follow the hatchery's own settings. To pick your own, turn off **Use the hatchery's look** in the options. Then choose a skin and a palette, and use the sun and moon button for dark or light. Your choice applies at once and stays in this browser.

## Polling

The extension asks the hatchery for changes every minute by default. You can set 30 s to 60 min. Browsers do not let an extension wake up more often than every 30 s. So a job that starts and ends between two polls shows up at the next poll, with both its start and its result.

Each poll reads `/health`, `/api/jobs` (running, queued and recent), `/api/runners`, `/api/hosts` and `/api/slots`. A job that was running and is no longer in the recent list is read with `/api/jobs/:id`, so long jobs still report how they ended. The popup also reads `/events/stream`, and `/api/settings` for the dashboard's skin, palette and mode (see Appearance). The options page reads `/api/repos` for the repo filter.

The extension never writes to the hatchery.

## Permissions

| Permission | Why |
|---|---|
| Access to your hatchery's site (asked when you click Connect) | Read the API with your sign-in cookies. Only the site you enter. |
| `storage` | Keep the settings (synced with your browser account), the last poll and the counters. |
| `alarms` | Poll on a timer while the popup is closed. |
| `notifications` | Show the alerts. |

The extension collects no data and sends nothing anywhere except to the hatchery you set.

## Development

- `extension/` is the source. `lib/` holds the logic with no browser calls (settings, API client, change detection, counters, alerts, icon drawing). The tests are in `test/extension/`.
- `bin/build-extension` copies the source and the vendored tailor files from `public/tailor/` into `dist/extension/`, writes the version from `package.json` into the manifests, and zips the result. `--no-zip` skips the zips. `--crx` also packs a signed `.crx` with Chrome's own packer (set `CHROME` when Chrome or Chromium is not on `PATH`).
- `bin/verify` runs the tests, checks that every script parses, and builds the extension into a temporary folder.

The pages use tailor, the same design system as the dashboard. Extension pages may not run inline scripts, so `theme.js` does the pre-paint theme switch that `tailor-head.html` does on the dashboard.
