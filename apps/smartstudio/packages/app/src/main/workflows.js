// What the generation server (ComfyUI, see comfy.js) is asked to run for a take: a graph in
// ComfyUI's API format, { [node id]: { class_type, inputs } }, an input that's another node's
// output written [node id, output index]. One per kind, built from ComfyUI's own templates
// (audio_ace_step_1_5_checkpoint, video_ltx2_5_t2v) with the take's prompt, length and seed.
// No Node or Electron here, so the tests build them too.

// The model files each kind needs on the server, by ComfyUI's model folder: what the server is
// asked for to say whether a kind can be made there (comfy.js's `status`).
export const MODELS = {
  music: {
    checkpoints: ['ace_step_1.5_turbo_aio.safetensors'],
  },
  video: {
    diffusion_models: ['ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'],
    text_encoders: ['gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors'],
    vae: ['ltx-2.5-video-vae-bf16.safetensors', 'ltx-2.5-audio-vae-bf16.safetensors'],
    latent_upscale_models: ['ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'],
  },
};

// SmartStudio's own nodes (server/comfyui/smartstudio_nodes, installed with
// scripts/install-comfy-nodes.sh), which what needs them can't be made without: comfy.js's `status`
// asks the server for them, as it does model files.
export const NODES = {
  repaint: ['SmartStudioAudioRepaintMask'],
};

// Where ComfyUI saves each kind's output, under its output folder: one folder of the app's own.
const PREFIX = { music: 'smartstudio/music', video: 'smartstudio/video' };

// ACE-Step 1.5 turbo (8 steps), from the all-in-one checkpoint: its language model writes the
// song's plan (with its own guidance, `cfg_scale`, from `planSeed`) before the diffusion model
// renders it (from `seed`). No lyrics is an instrumental.
export function musicGraph({ prompt, lyrics = '', seconds, seed, planSeed = seed }) {
  return {
    ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: MODELS.music.checkpoints[0] } },
    shift: { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['ckpt', 0], shift: 3 } },
    text: {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        clip: ['ckpt', 1],
        tags: prompt,
        lyrics: lyrics.trim() || '[Instrumental]',
        seed: planSeed,
        bpm: 120,
        duration: seconds,
        timesignature: '4',
        language: 'en',
        keyscale: 'C major',
        generate_audio_codes: true,
        cfg_scale: 2.0,
        temperature: 0.85,
        top_p: 0.9,
        top_k: 0,
        min_p: 0.0,
      },
    },
    negative: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['text', 0] } },
    latent: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds, batch_size: 1 } },
    sample: { class_type: 'KSampler', inputs: { model: ['shift', 0], positive: ['text', 0], negative: ['negative', 0], latent_image: ['latent', 0], seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    decode: { class_type: 'VAEDecodeAudio', inputs: { samples: ['sample', 0], vae: ['ckpt', 2] } },
    save: { class_type: 'SaveAudio', inputs: { audio: ['decode', 0], filename_prefix: PREFIX.music } },
  };
}

// LTX-2.5 distilled, text to video with its sound, in two stages as its template does: 8 steps at
// half the size, then the latent upscaled x2 and 3 more steps to refine it. 24 frames a second;
// the length in frames is seconds × 24 + 1. The size is 16:9, each side a multiple of 64 so both
// stages' sides are multiples of 32. (The template's prompt enhancer is left out: it needs a model
// of its own.)
export const VIDEO = { width: 1280, height: 704, fps: 24 };
const NEGATIVE = 'pc game, console game, video game, cartoon, childish, ugly';
export function videoGraph({ prompt, seconds, seed }) {
  const { width, height, fps } = VIDEO;
  const frames = Math.round(seconds * fps) + 1;
  const { diffusion_models: [unet], text_encoders: [encoder], vae: [videoVae, audioVae], latent_upscale_models: [upscaler] } = MODELS.video;
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: encoder, type: 'ltxv', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
    audioVae: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
    upscaler: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: upscaler } },
    positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: prompt } },
    negative: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: NEGATIVE } },
    conditioning: { class_type: 'LTXVConditioning', inputs: { positive: ['positive', 0], negative: ['negative', 0], frame_rate: fps } },
    guider: { class_type: 'LTXVDualCFGGuider', inputs: { model: ['unet', 0], positive: ['conditioning', 0], negative: ['conditioning', 1], video_cfg: 1, audio_cfg: 1 } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    // Stage one, at half the size.
    emptyVideo: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: width / 2, height: height / 2, length: frames, batch_size: 1 } },
    emptyAudio: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: ['audioVae', 0] } },
    together: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['emptyVideo', 0], audio_latent: ['emptyAudio', 0] } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' } },
    first: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['together', 0] } },
    firstApart: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['first', 0] } },
    // Stage two: the video upscaled x2, with stage one's sound, refined.
    upscaled: { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['firstApart', 0], upscale_model: ['upscaler', 0], vae: ['vae', 0] } },
    together2: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['upscaled', 0], audio_latent: ['firstApart', 1] } },
    noise2: { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
    sigmas2: { class_type: 'ManualSigmas', inputs: { sigmas: '0.85, 0.7250, 0.4219, 0.0' } },
    second: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise2', 0], guider: ['guider', 0], sampler: ['sampler', 0], sigmas: ['sigmas2', 0], latent_image: ['together2', 0] } },
    secondApart: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['second', 0] } },
    images: { class_type: 'VAEDecodeTiled', inputs: { samples: ['secondApart', 0], vae: ['vae', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    sound: { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['secondApart', 1], audio_vae: ['audioVae', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['images', 0], audio: ['sound', 0], fps } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: PREFIX.video, format: 'mp4', codec: 'h264' } },
  };
}

// Part of a song made again (a take `from` another: { start, end }, in seconds), the rest kept: the
// song (`audio`, its file on the server, see comfy.js's upload) is encoded, the stretch marked
// (SmartStudio's own mask node, fading in and out over half a second so the new part joins the old)
// and only that rendered again, from new noise (`seed`). The song's plan is made again from the
// seed it was first planned with (`planSeed`), so with the same prompt and lyrics the new part
// follows the song as planned, as loud and in time, and only how it's played changes; a changed
// prompt or lyrics plans it again, so the new part can differ more. (Tried on the GX10: the plan
// from a new seed, or none, left the new part out of step with the song: much quieter, as another
// part of a different song.)
export const FADE = 0.5;
export function repaintGraph({ audio, prompt, lyrics = '', seconds, seed, planSeed, from }) {
  const graph = musicGraph({ prompt, lyrics, seconds, seed, planSeed });
  delete graph.latent;
  graph.load = { class_type: 'LoadAudio', inputs: { audio } };
  graph.encode = { class_type: 'VAEEncodeAudio', inputs: { audio: ['load', 0], vae: ['ckpt', 2] } };
  graph.part = { class_type: NODES.repaint[0], inputs: { samples: ['encode', 0], start: from.start, end: from.end, fade: FADE, frames_per_second: 25 } };
  graph.sample.inputs.latent_image = ['part', 0];
  return graph;
}

// The file a take remaking part of another reads (`audio`: its name on the server) is the
// generator's to send first; this is only the graph.
export const graphFor = (take, { audio } = {}) => {
  if (take.kind === 'video') return videoGraph(take);
  if (take.from) return repaintGraph({ ...take, audio });
  return musicGraph(take);
};
