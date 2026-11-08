# Ultimate Volume Control

Make quiet sites louder, safely. A Chrome extension that boosts a tab's sound per site, up to 400%, with audio processing built the way mastering tools are. Everything stays on your device.

## Audio engine

- **True-peak limiter** with 4× oversampled detection (Kaiser-windowed sinc on the sidechain) and 5 ms look-ahead. It catches the peaks that form between samples, not only the samples themselves
- **Adjustable output ceiling**, 0 to −6 dBTP
- **No compressor, no pumping**: if a track keeps hitting the ceiling, the boost eases down over a few seconds and returns on the next track
- **Bit-exact at 100%**: the sound is exactly what the site sends
- **Loudness meters to ITU-R BS.1770-4**, momentary and short-term, plus true-peak in, out and limiting
- **Real-time safe**: runs in an AudioWorklet, the limiter and detector allocate nothing on the audio thread, and the engine rests when nothing plays

## Features

- **Up to 400%**
- **The boost lowers itself** when a track is too loud for the volume you chose, and comes back on the next video or page. Your slider stays where you put it
- **Per site**: "Allow on this site only" or "Allow on all sites", and the volume comes back by itself on your next visit. Volumes can also be kept for a single page or a pattern of addresses
- **A dot on the icon** for each tab: green when the boost is on, red when it should be on but isn't, none at normal volume. The tooltip gives the details, such as "Boost: 135% (400%). Saved."
- **Hear original** to compare with the untouched sound in one click
- **Saved sites page** to change, remove, export and import your volumes
- **Private**: no account, no server, no analytics, no network requests of its own

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

Most sites are boosted from inside the page: the extension routes the page's audio through an AudioWorklet that applies the gain and a look-ahead true-peak limiter (4× oversampled peak detection). Some sites make their sound in a way a page script can't reach, such as audio from servers that don't allow web pages to process it. On those, it uses Chrome's tab capture after you open the extension on that tab, and Chrome marks the tab as shared. Either way the sound goes only from the tab, through the limiter, to your speakers.

### Why Chrome warns at install

Chrome says this extension can "read and change all your data on all websites". Chrome uses those words for any extension that can capture a tab's sound. The extension changes only the sound of a tab you opened it on, or of a site you chose a volume for. Site access is optional and asked for only when you want a volume kept for your next visit.

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
