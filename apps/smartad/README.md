# SmartAd

A Mac app for designing adverts for the web with your own AI. It's one of a family with
[SmartDoc](https://github.com/tw050x/smartdoc), [SmartSpec](https://github.com/tw050x/smartspec)
and [SmartDesktop](https://github.com/tw050x/smartdesktop), whose chat runs your AI across them all.

Nothing is built yet: this is the brief.

## The brief

- **Designing and rendering only.** SmartAd makes the files an ad platform takes. Running ads,
  targeting, tracking and analytics are left to the platforms and other tools. The one piece of
  tracking in its files is the `clickTag` an HTML5 banner must have, which the ad network fills
  in.
- **AI first, AI led.** The AI designs and changes the ad, and the user directs it and accepts or
  discards what it proposes, as in SmartDoc and SmartSpec. There are no editing tools: no layer
  editing and no timeline to edit.
- **Animated as well as still.** A timeline is there for pointing at where an animation should
  change: a comment on a moment, a span, or a layer at a moment, with the AI's changes marked on
  it under review. The user can play, scrub and step through it, but nothing on it can be dragged.
- **An ad is data the app draws.** Layers (background, images, logo, text, the call to action,
  shapes), each with its content, style and placement rules, and its animation as tracks of
  keyframes. The AI changes it through MCP tools, and sees what it made as pictures of chosen
  moments.
- **One design, every size.** The standard display sizes (300×250, 728×90, 160×600, 300×600,
  320×50, 970×250…) and the social shapes (1:1, 4:5, 9:16), each laid out from the same design,
  and each checked against its platform's limits (file size, animation length, text lengths).
- **Exact exports.** Each frame is drawn at its moment and encoded, never recorded live: PNG, JPEG
  and WebP stills; HTML5 banners; GIF; MP4 and WebM video, encoded by Chromium's WebCodecs (H.264
  and HEVC in hardware on a Mac, VP9 and AV1 in software, AAC and Opus audio).
- **The family's design.** Windows of tabs, with Home the pinned first tab and each other tab one
  ad. For now Home is a single column of ads.

## Packages

- `packages/app`: the Electron app (`@smartad/app`).
- The file formats SmartAd writes, each a package of its own with no npm dependencies, working on
  plain byte arrays so it runs in the window and in Node:
  - `@smartad/mp4`: the MP4 container around H.264 or HEVC video and AAC audio;
  - `@smartad/webm`: the WebM (Matroska) container around VP9 or AV1 video and Opus audio;
  - `@smartad/gif`: animated GIFs, with their own colour reduction and LZW compression;
  - `@smartad/zip`: zip files with their own deflate, for HTML5 banners.

## Licence

MIT
