"""SmartStudio's own ComfyUI nodes: what its graphs need that ComfyUI's core nodes don't do.

Install: copy this folder into ComfyUI's custom_nodes folder and restart ComfyUI
(scripts/install-comfy-nodes.sh does it over SSH). The app checks the server has them
(comfy.js's status), as it checks for model files.

SmartStudioAudioRepaintMask: marks a stretch of an audio latent (from VAEEncodeAudio) to be made
again, the rest kept, for KSampler. ComfyUI's SetLatentNoiseMask shapes every mask as an image's
(batch, 1, height, width), which an audio latent's (batch, channels, time) can't take, so it's
made here in that shape: 1 in the stretch, 0 outside it, with a fade at each edge so the new part
joins the old without a seam.
"""

import torch


class SmartStudioAudioRepaintMask:
    CATEGORY = "SmartStudio"
    RETURN_TYPES = ("LATENT",)
    FUNCTION = "mask"
    DESCRIPTION = "Marks a stretch of an audio latent (start to end, in seconds) to be made again by the sampler; the rest is kept."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "start": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10000.0, "step": 0.01}),
                "end": ("FLOAT", {"default": 10.0, "min": 0.0, "max": 10000.0, "step": 0.01}),
                "fade": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 10.0, "step": 0.01, "tooltip": "Seconds at each edge over which the new part blends into the old."}),
                "frames_per_second": ("FLOAT", {"default": 25.0, "min": 0.1, "max": 1000.0, "step": 0.01, "tooltip": "Latent frames per second of audio (ACE-Step 1.5: 48000 / 1920 = 25)."}),
            }
        }

    def mask(self, samples, start, end, fade, frames_per_second):
        latent = samples["samples"]
        if latent.ndim != 3:
            raise ValueError(f"Expected an audio latent (batch, channels, time), got shape {tuple(latent.shape)}.")
        batch, _, length = latent.shape
        first = max(0, min(length, round(start * frames_per_second)))
        last = max(first, min(length, round(end * frames_per_second)))
        if last <= first:
            raise ValueError(f"Nothing to make again: {start}s to {end}s is outside the audio ({length / frames_per_second:.1f}s).")
        mask = torch.zeros((batch, 1, length), dtype=torch.float32)
        mask[:, :, first:last] = 1.0
        ramp = min(round(fade * frames_per_second), (last - first) // 2)
        if ramp > 0:
            rise = torch.linspace(0.0, 1.0, ramp + 2)[1:-1]
            # Only fade an edge inside the audio: a stretch from the very start (or to the end) has
            # nothing to join there.
            if first > 0:
                mask[:, :, first:first + ramp] = rise
            if last < length:
                mask[:, :, last - ramp:last] = rise.flip(0)
        out = samples.copy()
        out["noise_mask"] = mask
        return (out,)


NODE_CLASS_MAPPINGS = {"SmartStudioAudioRepaintMask": SmartStudioAudioRepaintMask}
NODE_DISPLAY_NAME_MAPPINGS = {"SmartStudioAudioRepaintMask": "Audio Repaint Mask (SmartStudio)"}
