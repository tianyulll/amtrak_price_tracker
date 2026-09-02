# Trackline — Amtrak Fare Watch

Trackline is a small Tampermonkey userscript that watches fares on an Amtrak departure-results page. It scans every results page, filters trips by departure time and price, and sends a desktop notification when a fare newly reaches your target.

Everything runs in your normal browser session. There is no server to start, no account to create, and no direct call to a private Amtrak API.

## What it does

- Scans all pages of an Amtrak departure search, not just the visible page.
- Filters departures by a time window, including windows that cross midnight.
- Shows the lowest fare and every matching fare.
- Refreshes the results tab on a schedule you choose.
- Sends a notification when a fare first meets your target or falls below it again.
- Keeps each browser tab's monitoring settings separate.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome, Edge, or Firefox.
2. Open the Tampermonkey dashboard and select **Create a new script**.
3. Delete the sample code in the editor.
4. Copy the complete contents of [`trackline-amtrak.user.js`](trackline-amtrak.user.js), paste it into the editor, and save.
5. Allow browser notifications for Tampermonkey when prompted.

After installation, the Trackline panel should appear in the lower-right corner of an Amtrak departure-results page. Its header should show **v0.5.2**.

## Watch a trip

1. Search for a one-way trip on [Amtrak](https://www.amtrak.com/) and wait for the departure results.
2. In the **Trackline** panel, optionally set a departure-time window using 24-hour time. For example, `06:30`–`10:00` watches morning trains. A window such as `22:30`–`02:15` crosses midnight.
3. Enter **Price at or below**. Leave this blank if you only want to browse fares in the selected time window without target notifications.
4. Choose a refresh interval. The default is 15 minutes and the minimum is 1 minute.
5. Select **Test notification** and confirm that a desktop notification appears.
6. Select **Start monitoring** and leave the Amtrak results tab open.

Trackline immediately scans the complete result set and then reloads the tab at your chosen interval. It returns the results view to page 1 after each scan.

## Alerts

Trackline sends one notification when a fare newly qualifies. It does not repeatedly notify you while the same fare stays below the target. If that fare rises above the target and later falls back below it, Trackline can notify you again.

The Amtrak tab and browser must remain open. Browsers may slow or pause background tabs, and a sleeping computer cannot run checks. Monitoring resumes when the browser restores the page.

Prices shown by Amtrak can change and remain subject to availability and confirmation during purchase.

## Useful controls

- **Scan now** runs a one-time scan without changing monitoring or sending target alerts.
- **Pause monitoring** stops scheduled reloads while preserving your filters and alert state.
- **− / +** collapses or restores the panel.
- Drag the Trackline header to reposition the panel.

Your filters, panel position, and monitoring state survive automatic reloads in the same tab. Starting monitoring in one tab does not start it in other Amtrak tabs.

## Troubleshooting

### The panel does not appear

Confirm that Tampermonkey is enabled, the script is enabled, and you are on an Amtrak departure-results page. Reload the page after installing or updating the script.

### The panel shows an older version

Open the script in Tampermonkey, replace all of its contents with the current [`trackline-amtrak.user.js`](trackline-amtrak.user.js), save, and reload the Amtrak tab.

### Notifications do not appear

Use **Test notification**, then check notification permissions for both your browser and operating system. Focus or Do Not Disturb modes can also hide alerts.

### A refresh shows no fares

Amtrak may expire a search or request interaction after a reload. Complete the search normally, then select **Scan now** or **Start monitoring** again. If a page cannot be read, Trackline preserves the last completed monitoring state.

## Development

Trackline has no package dependencies. Run its parser, time-window, threshold, and pagination tests with Node.js 18 or newer:

```bash
node --test tests/userscript.test.cjs
```

The browser fixture in [`tests/fixtures/userscript-smoke.html`](tests/fixtures/userscript-smoke.html) provides sample multi-page results for manual testing.

## Privacy and scope

The script stores its settings through Tampermonkey and reads only the Amtrak result page where it runs. It does not send your searches or fares to a separate Trackline service. Trackline is an independent utility and is not affiliated with or endorsed by Amtrak.
