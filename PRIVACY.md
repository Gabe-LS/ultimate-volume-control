# Ultimate Volume Control: privacy policy

Last updated: 7 November 2026

Ultimate Volume Control makes quiet sites louder. It does this entirely on your device.

## What it stores

The extension stores these on your device, using Chrome's own extension storage:

- the sites and pages you chose a volume for, and that volume
- patterns you wrote yourself
- your output ceiling setting
- the addresses (without the part after "?" or "#") of pages where you pressed "Reload without boost", so they load at normal volume next time. At most 200 are kept, the oldest going first. This list isn't shown on the Saved sites page or included in an export. Moving the slider on such a page takes it off the list, and removing a site's last saved volume removes that site's entries.

If you turn on Chrome sync, none of this is synced by the extension. It stays in local storage on that device.

While Chrome is open, it also keeps, for each tab it runs on, the websites of large embedded frames on the page (such as a video player from another site), to offer "Also boost the embedded player". This is held in Chrome's session storage and is gone when Chrome closes.

## What it sends

Nothing. The extension has no server, no analytics, no advertising and no tracking. It makes no network requests of its own.

## Sound

To change the volume, the extension passes a tab's sound through a limiter on your device, and straight on to your speakers. Sound is never recorded, saved or sent anywhere.

When a site makes its sound in a way the extension can't reach from inside the page, it uses Chrome's tab capture for that tab instead. Chrome then marks the tab as shared. The sound still goes only from the tab, through the limiter, to your speakers.

## Permissions

- **Storage:** keeps your volumes and settings.
- **Scripting and active tab:** applies the volume to the tab you opened the extension on.
- **Tab capture and offscreen:** boosts sound a page script can't reach, only after you have opened the extension on that tab. Because of this permission, Chrome warns at install that the extension can "read and change all your data on all websites". It uses that access only for the sound of tabs you boost.
- **Site access (optional):** you are asked only if you want a volume kept for your next visit. "Allow on this site only" covers one site. "Allow on all sites" covers every site: a small script then runs on every page you open, so a boost can start before the page's sound does. Until you choose a volume on a page, it passes that page's sound through unchanged, at 100%. It also notes the websites of large embedded frames on the page, as described above.

You can remove site access from Chrome's extension settings at any time. The other permissions are part of the extension and go when you uninstall it. You can delete every saved volume from the extension's Saved sites page. Uninstalling removes everything.

## Changes and contact

If this policy changes, the new version will appear here with a new date.

For questions about this policy, open an issue at [github.com/Gabe-LS/ultimate-volume-control](https://github.com/Gabe-LS/ultimate-volume-control/issues).
