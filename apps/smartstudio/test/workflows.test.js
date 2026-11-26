import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explain, failure, outputFile } from '../packages/app/src/main/comfy.js';
import { FADE, MODELS, NODES, VIDEO, graphFor, musicGraph, repaintGraph, videoGraph } from '../packages/app/src/main/workflows.js';

// Every input that's another node's output names a node in the graph.
function linksResolve(graph) {
  for (const [id, node] of Object.entries(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value)) assert.ok(graph[value[0]], `${id}.${name} points at ${value[0]}, which isn't there`);
    }
  }
}

test('a music take is ACE-Step 1.5\'s graph with its prompt, lyrics, length and seed', () => {
  const graph = musicGraph({ prompt: 'synth-pop', lyrics: '[Chorus]\nlight it up', seconds: 30, seed: 9 });
  linksResolve(graph);
  assert.equal(graph.ckpt.inputs.ckpt_name, MODELS.music.checkpoints[0]);
  assert.equal(graph.text.inputs.tags, 'synth-pop');
  assert.equal(graph.text.inputs.lyrics, '[Chorus]\nlight it up');
  assert.equal(graph.text.inputs.duration, 30);
  assert.equal(graph.latent.inputs.seconds, 30);
  assert.equal(graph.sample.inputs.seed, 9);
  assert.equal(musicGraph({ prompt: 'ambient', seconds: 10, seed: 1 }).text.inputs.lyrics, '[Instrumental]');
});

test('a video take is LTX-2.5\'s two stages, the first at half the size, frames of 24 a second', () => {
  const graph = videoGraph({ prompt: 'rain on a window', seconds: 5, seed: 3 });
  linksResolve(graph);
  assert.equal(graph.emptyVideo.inputs.length, 121);
  assert.equal(graph.emptyVideo.inputs.width * 2, VIDEO.width);
  assert.equal(graph.emptyVideo.inputs.height % 32, 0);
  assert.equal(graph.noise.inputs.noise_seed, 3);
  assert.equal(graph.upscaled.inputs.samples[0], 'firstApart');
  assert.equal(graph.unet.inputs.unet_name, MODELS.video.diffusion_models[0]);
  assert.equal(graphFor({ kind: 'video', prompt: 'x', seconds: 2, seed: 0 }).save.class_type, 'SaveVideo');
  assert.equal(graphFor({ kind: 'music', prompt: 'x', seconds: 5, seed: 0 }).save.class_type, 'SaveAudio');
});

test('what ComfyUI says back is read: its file, why it failed, why it refused', () => {
  assert.deepEqual(outputFile({ outputs: { save: { audio: [{ filename: 'a_00001.flac', subfolder: 'smartstudio/music', type: 'output' }] } } }), { filename: 'a_00001.flac', subfolder: 'smartstudio/music', type: 'output' });
  assert.equal(outputFile({ outputs: { preview: { images: [{ filename: 'p.png', type: 'temp' }] } } }), null);
  assert.equal(failure({ status: { messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory\nmore' }]] } }), 'KSampler failed: CUDA out of memory');
  assert.match(explain({ node_errors: { unet: { class_type: 'UNETLoader', errors: [{ type: 'value_not_in_list', details: "unet_name: 'ltx.safetensors' not in []" }] } } }), /doesn't have the model files for this: ltx\.safetensors/);
});

test('a part of a song made again encodes the song, marks the stretch, and renders it from new noise on the song\'s plan', () => {
  const take = { kind: 'music', prompt: 'synth-pop', lyrics: '[Chorus]', seconds: 30, seed: 5, planSeed: 1975, from: { take: 't-aaaaaa', start: 12, end: 20 } };
  const graph = graphFor(take, { audio: 'smartstudio-p-t-aaaaaa.flac' });
  linksResolve(graph);
  assert.deepEqual(graph, repaintGraph({ ...take, audio: 'smartstudio-p-t-aaaaaa.flac' }));
  assert.equal(graph.latent, undefined);
  assert.equal(graph.load.inputs.audio, 'smartstudio-p-t-aaaaaa.flac');
  assert.equal(graph.part.class_type, NODES.repaint[0]);
  assert.deepEqual([graph.part.inputs.start, graph.part.inputs.end, graph.part.inputs.fade], [12, 20, FADE]);
  assert.deepEqual(graph.sample.inputs.latent_image, ['part', 0]);
  assert.equal(graph.sample.inputs.seed, 5);
  assert.equal(graph.text.inputs.seed, 1975);
  assert.equal(graph.text.inputs.duration, 30);
  // A song made from nothing plans with its own seed.
  assert.equal(musicGraph({ prompt: 'x', seconds: 10, seed: 3 }).text.inputs.seed, 3);
});
