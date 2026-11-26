# SmartStudio

A Mac app for making music and video with your own AI, on your own generation server: ComfyUI on
a machine with a GPU (an Asus Ascent GX10, at first). It's one of a family with
[SmartDoc](https://github.com/tw050x/smartdoc), [SmartSpec](https://github.com/tw050x/smartspec),
[SmartAd](https://github.com/tw050x/smartad), [SmartPrep](https://github.com/tw050x/smartprep),
[SmartPlan](https://github.com/tw050x/smartplan) and [SmartDesktop](https://github.com/tw050x/smartdesktop),
whose chat runs your AI across them all.

## The brief

- **A project is something being made**: a song, a clip, an advert's soundtrack. Audio and video
  together or apart: each take is music (a song with lyrics, or an instrumental) or video (a clip,
  with its sound).
- **A take is a prompt and what came back.** The user writes the prompt in the project's tab
  (Music or Video, what to make, the lyrics, how long) and presses Generate; the AI can ask for
  takes too, through MCP tools. Each take shows how it's going, then plays in the tab. Takes are
  kept with their prompt and seed, so any can be made again or varied.
- **The user's own generation server.** Takes are made by ComfyUI at the address in Settings:
  music with ACE-Step 1.5 (turbo), video with LTX-2.5 (distilled, two stages, with its sound).
  The server runs one job at a time; SmartStudio follows each to the end and keeps its file.
- **The family's design.** Windows of tabs, with Home the pinned first tab and each other tab one
  project. For now Home is a single column of projects.

## Packages

- `packages/app`: the Electron app (`@smartstudio/app`). MCP server on 47850 (installed) and 47851
  (development); data in `SmartStudio` / `SmartStudio Dev` (`SMARTSTUDIO_USER_DATA`,
  `SMARTSTUDIO_PORT`): `projects/<id>/project.json` and each take's file in `projects/<id>/media`.
- `packages/cli`: the `smartstudio` command, connecting an AI app by hand (`@smartstudio/cli`).

## The generation server

ComfyUI, with these model files in its `models` folder:

| Kind | Folder | File |
|---|---|---|
| Music | `checkpoints` | `ace_step_1.5_turbo_aio.safetensors` (Comfy-Org/ACE-Step-1.5) |
| Video | `diffusion_models` | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` (Lightricks/LTX-2.5) |
| Video | `text_encoders` | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` |
| Video | `vae` | `ltx-2.5-video-vae-bf16.safetensors`, `ltx-2.5-audio-vae-bf16.safetensors` |
| Video | `latent_upscale_models` | `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` |

The graphs sent are in `packages/app/src/main/workflows.js`, built from ComfyUI's own templates.

Making part of a song again also needs SmartStudio's own node (`server/comfyui/smartstudio_nodes`:
ComfyUI's `SetLatentNoiseMask` can't mask an audio latent). Install it, and restart ComfyUI, with

```sh
scripts/install-comfy-nodes.sh [host] [custom nodes folder] [container]   # defaults: the GX10's
```

## Timelines

Each finished take plays on a timeline: its waveform (a clip's frames above it), measured once in
the page and kept beside the take (`<take>.level.json`). Drag across it to select a part, then play
it, note it, ask your AI about it, or (music) make just that part again: a new take, the rest of
the song kept. Your AI sees the same: `get_selection` (the part selected, how it sounds from its
loudness, and a clip's frames as pictures), `inspect_take`, `remake_part` and `add_note`.

## Running it

```sh
npm install
npm start     # builds the renderer and opens the app
npm test
```

After changing the tools in `mcp-tools.js`, run `npm run server-snapshot`.
