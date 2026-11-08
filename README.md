# Ultimate Volume Control

Make quiet sites louder. A Chrome extension that boosts a tab's sound per site, up to 400%, through a true-peak limiter of the kind used in mastering. Everything stays on your device.

## Audio engine

- **Stereo-linked true-peak limiter** with 4× oversampled detection (Kaiser-windowed sinc on the sidechain) and 5 ms look-ahead. It catches the peaks that form between samples, not only the samples themselves.
- **Adjustable output ceiling**, 0 to −6 dBTP, for what the boost adds: a source already above it is never turned below 100%. Against an independent reference, band-limited test signals read at most 0.1 dB over it; hard-clipped and near-Nyquist test signals reach about 1.2 dB over.
- **No compressor**: a track with room for the boost gets exact gain, sample for sample. If a track keeps hitting the ceiling, the boost eases down over a few seconds until the limiter does about 1 dB of work; until it settles, the limiter carries the excess, at some cost to dynamics. The lowered boost stays on that page, across tracks, until "Restore boost", a reload, a higher slider setting or another page.
- **Bit-exact at 100%**: the limiter passes every sample through unchanged, delayed only by its look-ahead.
- **Meters**: momentary and short-term loudness to ITU-R BS.1770-4, checked against EBU Tech 3341, true peak in and out, and limiter gain reduction.
- **Real-time safe**: the limiter and detector allocate nothing while processing. They run in an AudioWorklet, or in a ScriptProcessor fallback on plain-HTTP pages and where a page's CSP blocks the worklet. The extension's own audio engine rests after 10 s with nothing playing.

## Features

- **Up to 400%** on quiet sound. Loud music gets less, and the boost lowers itself for that page only: your slider and saved volume stay where you put them.
- **Per site**: "Allow on this site only" or "Allow on all sites", and the volume comes back by itself on your next visit (on sites only tab capture can reach, after a click on the icon). Volumes can also be kept for a single page or a pattern of addresses.
- **A dot on the icon** for each tab: green when the boost is on, red when it should be on but isn't, none at normal volume. The tooltip gives the details, such as "Boost: 135% (400%). Saved."
- **Hear original** to compare with the untouched sound in one click.
- **Saved sites page** to change, remove, export and import your volumes.
- **Private**: no account, no server, no analytics, no network requests of its own.

## Install

### From source (developer mode)

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `extension/` folder

Chrome 116 or later.

### From Chrome Web Store

Coming soon.

## How it works

Most sites are boosted from inside the page: the extension routes the page's audio through an AudioWorklet that applies the gain and the true-peak limiter, or through a ScriptProcessor running the same code where the page allows no worklet. Some sites make their sound in a way a page script can't reach, such as audio from servers that don't allow web pages to process it. On those, it uses Chrome's tab capture after you open the extension on that tab, and Chrome marks the tab as shared. Either way the sound goes only from the tab, through the limiter, to your speakers.

### Known limits

- A site that switches a boosted track to a source the extension can't reach can go silent. The dot turns red, and "Reload without boost" in the popup plays that page at normal volume.
- When one sound on a page is boosted from inside the page, tab capture doesn't start, so another sound there that can't be reached plays at its normal level.
- The ceiling applies to each frame on its own: two embedded players playing at once can sum above it.
- With tab capture, the first 0.1 to 0.15 s of sound after more than about 12 s of silence can be missed.

### Why Chrome warns at install

Chrome says this extension can "read and change all your data on all websites". Chrome uses those words for any extension that can capture a tab's sound. The extension changes only the sound of a tab you opened it on, or of a site you chose a volume for. Site access is optional and asked for only when you want a volume kept for your next visit. With "Allow on all sites", a small script loads on every page so a boost can start before the page's sound does, and it leaves the sound unchanged, at 100%, until you choose a volume there.

## Project structure

```
extension/           Chrome extension source (load this folder)
  manifest.json      Manifest V3
  background/        Service worker: rules, access, capture, the icon's dot and tooltip
  content/           Page scripts: route the page's audio through the limiter
  worklet/           AudioWorklet processor
  dsp/               True-peak detector, limiter and meters
  capture/           Offscreen document for tab capture
  popup/             Slider, meters and access choices
  options/           Saved sites page
  rules/             Matching addresses to saved volumes
  ui/                Colours and type shared by the popup and the Saved sites page
```

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Support

Found a bug or have a question? [Open an issue](https://github.com/Gabe-LS/ultimate-volume-control/issues).
