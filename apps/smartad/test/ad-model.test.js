import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EASES, SIZE_PRESETS, changedSpans, checkAd, checkSize, ease, layerAt, layoutText, layersAt,
  normalizeAd, resolveSize, stateAt, summarize, validateAd, valueAt,
} from '../packages/app/src/main/ad-model.js';
import { ANIMATED_AD, STILL_AD } from '../packages/app/src/renderer/ad-samples.js';

const ok = (content) => {
  const result = validateAd(content);
  assert.ok(result.ok, result.errors?.join('\n'));
  return result.ad;
};
const errorsOf = (content) => {
  const result = validateAd(content);
  assert.equal(result.ok, false, 'expected errors');
  return result.errors;
};
const has = (errors, start, includes = '') => {
  assert.ok(errors.some((e) => e.startsWith(start) && e.includes(includes)), `no error "${start}…${includes}" in:\n${errors.join('\n')}`);
};
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const ad = (layers, more = {}) => ({ duration: 6, sizes: ['300x250'], layers, ...more });
const text = (more = {}) => ({ id: 'headline', kind: 'text', text: 'Hello there', frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 }, ...more });

test('presets: the IAB display sizes and the social shapes', () => {
  const ids = SIZE_PRESETS.map((p) => p.id);
  for (const id of ['300x250', '728x90', '160x600', '300x600', '320x50', '320x100', '336x280', '970x250', 'square', 'portrait', 'story', 'landscape']) {
    assert.ok(ids.includes(id), id);
  }
  assert.deepEqual(resolveSize('story'), { id: 'story', width: 1080, height: 1920, name: 'Story 9:16', kind: 'social' });
  assert.equal(resolveSize('728x90').name, 'Leaderboard');
  assert.equal(resolveSize('1080x1920').id, 'story', 'dimensions of a preset are that preset');
  assert.equal(resolveSize('Leaderboard').id, '728x90');
  assert.deepEqual(resolveSize('640x480'), { id: '640x480', width: 640, height: 480, name: '640×480', kind: 'display' });
  assert.equal(resolveSize({ width: 500, height: 400 }).id, '500x400');
  assert.equal(resolveSize({ id: 'story' }).height, 1920);
  assert.equal(resolveSize('nonsense'), null);
  assert.equal(resolveSize({ width: 5, height: 5 }), null);
});

test('the samples are valid, and validating a normalised ad changes nothing', () => {
  for (const sample of [STILL_AD, ANIMATED_AD]) {
    const normal = ok(sample);
    const again = ok(normal);
    assert.deepEqual(again, normal);
    assert.equal(normalizeAd(normal), normal, 'a normalised ad is used as it is');
  }
  assert.ok(validateAd(JSON.stringify(STILL_AD)).ok, 'JSON text is read');
});

test('normalising fills in defaults, resolves sizes and lists fonts', () => {
  const normal = ok(ad([
    text({ animation: { opacity: [{ t: 1, value: 1 }, { t: 0, value: 0 }] } }),
    { id: 'cta', kind: 'button', text: 'Go', style: { font: 'georgia', weight: 'bold' } },
    { id: 'box', kind: 'shape', style: { color: 'red' } },
  ], { sizes: ['story', { width: 640, height: 480 }] }));
  assert.equal(normal.loops, 1);
  assert.equal(normal.background, '#ffffff');
  assert.deepEqual(normal.sizes.map((s) => s.id), ['story', '640x480']);
  assert.deepEqual(normal.fonts, ['Georgia', 'SF Pro']);
  const [headline, cta, box] = normal.layers;
  assert.equal(headline.style.fit, 'shrink');
  assert.equal(headline.style.reveal, 'words');
  assert.deepEqual(headline.animation, [{ property: 'opacity', keyframes: [{ t: 0, value: 0, ease: 'in-out' }, { t: 1, value: 1, ease: 'in-out' }] }], 'shorthand made a track, keyframes sorted');
  assert.equal(headline.from, 0);
  assert.equal(headline.until, 6);
  assert.equal(cta.style.weight, 700);
  assert.equal(cta.style.align, 'center');
  assert.equal(cta.style.valign, 'middle');
  assert.deepEqual(cta.frame, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(box.shape, 'rect');
  assert.equal(box.style.background, 'red', "a shape's color is its fill");
  assert.equal('color' in box.style, false);
  assert.equal('thickness' in box.style, false, 'only lines have a thickness');
});

test('mistakes are reported with their path and what to write instead', () => {
  has(errorsOf({}), 'sizes: must list at least one size');
  has(errorsOf({ sizes: ['300x250'] }), 'layers: must be a list');
  has(errorsOf('{ not json'), 'ad: not valid JSON');
  has(errorsOf(ad([], { duration: 90 })), 'duration: 90 must be seconds from 0 (a still ad) to 60');
  has(errorsOf(ad([], { loops: 0 })), 'loops: 0 must be a whole number from 1 to 10');
  has(errorsOf(ad([], { background: 'blu' })), 'background: "blu" isn\'t a colour or gradient');
  has(errorsOf(ad([], { sizes: ['300x251x'] })), 'sizes[0]: "300x251x" isn\'t a size');
  has(errorsOf(ad([], { sizes: ['300x250', '300x250'] })), 'sizes[1]: "300x250" is listed twice');
  has(errorsOf(ad([], { colour: 'red' })), 'colour: not something an ad has');

  has(errorsOf(ad([{ kind: 'text', text: 'Hi' }])), 'layers[0].id: missing; give it an id');
  has(errorsOf(ad([{ id: 'Head Line', kind: 'text', text: 'Hi' }])), 'layers[0].id: "Head Line"', 'such as "head-line"');
  has(errorsOf(ad([text(), text()])), 'layers[1].id: "headline" is used by another layer');
  has(errorsOf(ad([{ id: 'a', kind: 'txt', text: 'Hi' }])), 'layers[0].kind: "txt"', "did you mean 'text'?");
  has(errorsOf(ad([{ id: 'a', kind: 'cta', text: 'Hi' }])), 'layers[0].kind', "did you mean 'button'?");
  has(errorsOf(ad([{ id: 'a', kind: 'text' }])), 'layers[0].text: missing');
  has(errorsOf(ad([{ id: 'a', kind: 'image' }])), 'layers[0].asset: missing');
  has(errorsOf(ad([{ id: 'a', kind: 'image', asset: 'logo' }], { assets: [{ id: 'hero' }] })), 'layers[0].asset: no asset "logo"; the ad\'s assets are hero');
  has(errorsOf(ad([{ id: 'a', kind: 'shape', shape: 'circle' }])), 'layers[0].shape: "circle"', "an 'ellipse' in a square frame");
  has(errorsOf(ad([text({ frame: { x: 0, y: 0, w: 0, h: 1 } })])), 'layers[0].frame.w: 0 must be a number above 0');
  has(errorsOf(ad([text({ frame: { x: 0, y: 0, w: 1 } })])), 'layers[0].frame.h: missing');
  has(errorsOf(ad([text({ frame: { x: 0, y: 0, width: 1, h: 1 } })])), 'layers[0].frame.width: not something a frame has; did you mean w?');

  has(errorsOf(ad([text({ style: { colour: 'red' } })])), 'layers[0].style.colour: not a style property; did you mean color?');
  has(errorsOf(ad([text({ style: { color: 'reddish' } })])), 'layers[0].style.color: "reddish" isn\'t a colour');
  has(errorsOf(ad([text({ style: { fit: 'cover' } })])), "layers[0].style.fit: \"cover\" must be 'shrink' or 'none' on a text layer");
  has(errorsOf(ad([text({ style: { font: 'Comic Sans' } })])), 'layers[0].style.font: "Comic Sans" isn\'t a font SmartAd can use yet');
  has(errorsOf(ad([text({ style: { weight: 950 } })])), 'layers[0].style.weight: 950 must be a whole number from 100 to 900');
  has(errorsOf(ad([text({ style: { size: 2 } })])), 'layers[0].style.size: 2 must be above 0 and at most 1');
  has(errorsOf(ad([text({ style: { size: '12pt' } })])), 'layers[0].style.size: "12pt" must be a number');
  has(errorsOf(ad([{ id: 'a', kind: 'shape', style: { font: 'Georgia' } }])), "layers[0].style.font: doesn't apply to a shape layer");
  has(errorsOf(ad([{ id: 'a', kind: 'shape', style: { reveal: 'words' } }])), "layers[0].style.reveal: 'words' is for text layers");
  has(errorsOf(ad([{ id: 'a', kind: 'shape', style: { thickness: 0.01 } }])), 'layers[0].style.thickness: only a line has a thickness');
  has(errorsOf(ad([text({ style: { border: { color: 'red' } } })])), 'layers[0].style.border.width: a border needs a width');

  has(errorsOf(ad([text({ from: 4, until: 2 })])), 'layers[0].until: 2 must be after from (4)');
  has(errorsOf(ad([text({ until: 8 })])), "layers[0].until: 8 is past the ad's end; it must be within 0–6.0 (the duration)");
  has(errorsOf(ad([text({ animation: [{ property: 'opacity', keyframes: [{ t: 0, value: 0 }, { t: 7, value: 1 }] }] })])),
    "layers[0].animation[0].keyframes[1].t: 7 is past the ad's end; it must be within 0–6.0 (the duration)");
  has(errorsOf(ad([text({ animation: [{ property: 'opacity', keyframes: [{ t: 0, value: 2 }] }] })])), 'layers[0].animation[0].keyframes[0].value: 2 must be a number from 0 to 1');
  has(errorsOf(ad([text({ animation: [{ property: 'fade', keyframes: [{ t: 0, value: 0 }] }] })])), 'layers[0].animation[0].property: "fade" can\'t be animated');
  has(errorsOf(ad([text({ animation: { rotation: [{ t: 0, value: 0 }] } })])), 'layers[0].animation.rotation', 'did you mean rotate?');
  has(errorsOf(ad([text({ animation: [{ property: 'x', keyframes: [{ t: 0, value: 0 }] }, { property: 'x', keyframes: [{ t: 1, value: 0 }] }] })])), 'layers[0].animation[1]: x is already animated by layers[0].animation[0]');
  has(errorsOf(ad([text({ animation: { x: [{ t: 0, value: 0, ease: 'easeOut' }] } })])), 'layers[0].animation.x[0].ease: "easeOut" isn\'t an ease');
  has(errorsOf(ad([text({ animation: { x: [] } })])), 'layers[0].animation.x: must be a list of at least one keyframe');
  has(errorsOf(ad([text({ animation: { x: [{ time: 0, value: 0 }] } })])), 'layers[0].animation.x[0].time: not something a keyframe has; did you mean t?');

  has(errorsOf(ad([text({ animation: { opacity: [{ t: 0, value: 0 }] } })], { duration: 0 })), "layers[0].animation: a still ad (duration 0) can't animate");
  has(errorsOf(ad([text({ from: 1 })], { duration: 0 })), 'layers[0].from: a still ad (duration 0) shows everything at once');

  has(errorsOf(ad([text({ sizes: { leaderboard: { hidden: true } } })], { sizes: ['300x250', '728x90'] })), 'layers[0].sizes.leaderboard: no size with id "leaderboard"; did you mean 728x90?');
  has(errorsOf(ad([text({ sizes: { '300x250': { text: '' } } })])), 'layers[0].sizes.300x250.text: must be the words to show');
  has(errorsOf(ad([text({ sizes: { '300x250': { frame: { w: -1 } } } })])), 'layers[0].sizes.300x250.frame.w: -1 must be a number above 0');
});

test('layerAt merges a size\'s overrides, and is null where the layer is hidden', () => {
  const normal = ok(ad([text({ style: { color: '#111111' }, sizes: { '728x90': { frame: { y: 0.5 }, style: { size: 0.12 }, text: 'Short' }, story: { hidden: true } } })], { sizes: ['300x250', '728x90', 'story'] }));
  const base = layerAt(normal, 'headline', '300x250');
  assert.equal(base.text, 'Hello there');
  assert.equal('sizes' in base, false);
  const wide = layerAt(normal, 'headline', '728x90');
  assert.deepEqual(wide.frame, { x: 0.1, y: 0.5, w: 0.8, h: 0.3 });
  assert.equal(wide.style.size, 0.12);
  assert.equal(wide.style.color, '#111111', 'what the override leaves alone stays');
  assert.equal(wide.text, 'Short');
  assert.equal(layerAt(normal, 'headline', 'story'), null);
  assert.equal(stateAt(normal, 'story', 1).layers.length, 0);
  assert.equal(layersAt(normal, '728x90').length, 1);
});

test('eases start at 0 and end at 1 exactly', () => {
  for (const name of Object.keys(EASES)) {
    assert.equal(ease(name, 0), 0, `${name} at 0`);
    assert.equal(ease(name, 1), 1, `${name} at 1`);
  }
  close(ease('linear', 0.25), 0.25);
  assert.ok(ease('in', 0.5) < 0.5 && ease('out', 0.5) > 0.5);
  close(ease('in-out', 0.5), 0.5, 0.1);
  const peak = Math.max(...Array.from({ length: 99 }, (_, i) => ease('back-out', (i + 1) / 100)));
  assert.ok(peak > 1.02, 'back-out overshoots');
  assert.equal(ease('step', 0.99), 0, 'step holds until the keyframe');
  assert.ok(ease('bounce', 0.5) > 0 && ease('bounce', 0.5) < 1);
});

test('values between keyframes, before the first and after the last', () => {
  const keyframes = [{ t: 1, value: 0 }, { t: 3, value: 10, ease: 'linear' }, { t: 3, value: 20 }, { t: 5, value: 0, ease: 'out' }];
  assert.equal(valueAt(keyframes, 0), 0);
  assert.equal(valueAt(keyframes, 1), 0);
  close(valueAt(keyframes, 2), 5);
  assert.equal(valueAt(keyframes, 3), 20, 'two keyframes at one moment jump');
  assert.equal(valueAt(keyframes, 5), 0);
  assert.equal(valueAt(keyframes, 6), 0);
  assert.ok(valueAt(keyframes, 4) < 10, "'out' has gone more than halfway at halfway");
});

test('stateAt gives every layer showing, in pixels', () => {
  const normal = ok(ad([
    { id: 'back', kind: 'shape', frame: { x: 0, y: 0, w: 1, h: 1 }, style: { opacity: 0.5 }, animation: { opacity: [{ t: 0, value: 0 }, { t: 2, value: 1, ease: 'linear' }] } },
    text({
      from: 1, until: 4, style: { size: 0.08, padding: '4px', radius: 0.5 },
      animation: { x: [{ t: 1, value: -0.5 }, { t: 2, value: 0, ease: 'linear' }], scale: [{ t: 1, value: 0 }, { t: 2, value: 1 }], rotate: [{ t: 0, value: 90 }], reveal: [{ t: 1, value: 0 }, { t: 3, value: 1, ease: 'linear' }] },
    }),
  ]));
  const at0 = stateAt(normal, '300x250', 0);
  assert.deepEqual(at0.layers.map((l) => l.id), ['back'], 'not yet showing');
  assert.equal(at0.layers[0].opacity, 0);
  const s = stateAt(normal, '300x250', 1.5);
  assert.deepEqual(s.size, resolveSize('300x250'));
  const [back, headline] = s.layers;
  close(back.opacity, 0.5 * 0.75, 1e-9);
  assert.deepEqual(headline.frame, { x: 30, y: 25, w: 240, h: 75 });
  close(headline.x, -0.25 * 300);
  assert.equal(headline.y, 0);
  assert.equal(headline.rotate, 90);
  close(headline.reveal, 0.25);
  close(headline.style.size, 0.08 * Math.sqrt(300 * 250));
  assert.equal(headline.style.padding, 4);
  assert.equal(headline.style.radius, 37.5, "radius is a fraction of the layer's smaller side");
  assert.ok(headline.style.family.includes('-apple-system'));
  close(headline.box.w, 240 * headline.scale);
  assert.equal(stateAt(normal, '300x250', 4).layers.length, 1, 'until is the moment it goes');
  assert.equal(stateAt(normal, '300x250', 99).t, 6, 'time is clamped to the ad');
  const end = ok(ad([text({ from: 2 })]));
  assert.equal(stateAt(end, '300x250', 6).layers.length, 1, 'a layer that lasts to the end shows at the end');
  const still = ok(STILL_AD);
  assert.equal(stateAt(still, '300x250', 0).layers.length, 6);
});

test('text shrinks to fit its frame, to the quarter pixel, the same each time', () => {
  const normal = ok(ad([text({ text: 'Fresh food at your door in an hour, every day of the week', frame: { x: 0, y: 0, w: 0.5, h: 0.2 }, style: { size: 0.2 } })]));
  const [entry] = layersAt(normal, '300x250');
  const a = layoutText(entry);
  assert.ok(a.shrunk && !a.overflow);
  assert.ok(a.size < entry.style.size);
  assert.equal(a.size * 4, Math.round(a.size * 4));
  assert.ok(a.lines.length * a.lineHeight <= a.height + 0.5);
  assert.deepEqual(layoutText(entry), a);
  const none = ok(ad([text({ text: 'Fresh food at your door in an hour', frame: { x: 0, y: 0, w: 0.3, h: 0.05 }, style: { size: 0.2, fit: 'none' } })]));
  assert.equal(layoutText(layersAt(none, '300x250')[0]).overflow, true);
  const fixed = (t) => t.length * 10; // a measure: every character 10 px
  const lines = layoutText({ ...entry, text: 'aaaa bbbb cccc', style: { ...entry.style, size: 10, fit: 'none', lineHeight: 1 }, frame: { x: 0, y: 0, w: 95, h: 100 } }, fixed);
  assert.deepEqual(lines.lines.map((l) => l.text), ['aaaa bbbb', 'cccc']);
  const pill = layoutText({ ...entry, style: { ...entry.style, radius: 20, padding: 2 }, frame: { x: 0, y: 0, w: 200, h: 40 } }, fixed);
  assert.deepEqual(pill.inset, { x: 10, y: 2 }, "a pill's text keeps clear of its ends");
});

test('summarize says what each layer is and does when', () => {
  const summary = summarize(ok(ANIMATED_AD));
  assert.match(summary, /^Animated ad, 6\.0 s, played 2 times, background #f6f1e7, in 3 sizes: 300x250 \(Medium rectangle\), 728x90 \(Leaderboard\), story \(Story 9:16, 1080x1920\)\./);
  assert.match(summary, /- logo: image of Larder logo; fades in 0\.0–0\.5 s/);
  assert.match(summary, /- headline: text “Fresh food at your door in an hour”; shows 0\.0–3\.3 s; appears word by word 0\.5–1\.4 s; fades out and slides up and away 2\.9–3\.3 s/);
  assert.match(summary, /- produce: .*slides in from the right 0\.2–1\.0 s/);
  assert.match(summary, /- cta: button “Order now”; .*pops in 1\.3–1\.8 s/);
  assert.match(summary, /- rule: line; wipes in from the left 0\.3–0\.8 s; hidden at 728x90/);
  assert.match(summarize(ok(STILL_AD)), /^Still ad, background #f6f1e7, in 1 size: 300x250 \(Medium rectangle\)\. 6 layers, back to front:/);
});

test('changedSpans marks what a proposal adds, removes and changes, and when', () => {
  const before = ok(ANIMATED_AD);
  assert.deepEqual(changedSpans(before, ANIMATED_AD), []);
  const layers = structuredClone(ANIMATED_AD.layers);
  const cta = layers.find((l) => l.id === 'cta');
  cta.animation.scale = [{ t: 1.3, value: 0 }, { t: 1.8, value: 1, ease: 'back-out' }]; // the pulse at 4.6–5.1 s goes
  layers.find((l) => l.id === 'headline').text = 'Fresh food, fast';
  const after = {
    ...ANIMATED_AD,
    layers: [...layers.filter((l) => l.id !== 'rule'), { id: 'badge', kind: 'text', text: 'New', from: 2, until: 5 }],
  };
  const spans = changedSpans(before, after);
  const of = (id) => spans.filter((s) => s.layer === id);
  assert.deepEqual(of('badge'), [{ layer: 'badge', from: 2, to: 5, kind: 'added' }]);
  assert.deepEqual(of('rule'), [{ layer: 'rule', from: 0, to: 6, kind: 'removed' }]);
  assert.deepEqual(of('headline'), [{ layer: 'headline', from: 0, to: 3.3, kind: 'changed' }]);
  const [pulse] = of('cta');
  assert.equal(of('cta').length, 1);
  assert.equal(pulse.kind, 'changed');
  assert.ok(pulse.from > 4.6 && pulse.from < 4.65 && pulse.to > 5.05 && pulse.to <= 5.1, JSON.stringify(pulse));
  assert.deepEqual(of('logo'), []);
  const background = changedSpans(before, { ...ANIMATED_AD, background: '#ffffff' });
  assert.deepEqual(background, [{ layer: null, from: 0, to: 6, kind: 'changed' }]);
});

test('checkSize warns about small text, overflow, layers off the canvas and play time', () => {
  assert.deepEqual(checkAd(ok(ANIMATED_AD)), []);
  assert.deepEqual(checkAd(ok(STILL_AD)), []);
  const normal = ok(ad([
    text({ text: 'A rather long headline that has to shrink a lot', frame: { x: 0.05, y: 0.1, w: 0.4, h: 0.4 } }),
    text({ id: 'tiny', text: 'Terms apply', style: { size: '7px' }, frame: { x: 0.5, y: 0.8, w: 0.4, h: 0.2 } }),
    text({ id: 'spill', text: 'Words that will not fit at all in here', frame: { x: 0.5, y: 0, w: 0.1, h: 0.05 }, style: { fit: 'none' } }),
    text({ id: 'edge', text: 'Over the edge', frame: { x: 0.8, y: 0.1, w: 0.4, h: 0.2 } }),
    { id: 'gone', kind: 'shape', frame: { x: 1.2, y: 0, w: 0.2, h: 0.2 } },
    { id: 'enters', kind: 'shape', frame: { x: 1.2, y: 0, w: 0.2, h: 0.2 }, animation: { x: [{ t: 0, value: 0 }, { t: 1, value: -0.5 }] } },
  ], { duration: 12, loops: 4, sizes: ['300x250', '320x50', 'story'] }));
  const warnings = checkSize(normal, '320x50');
  const about = (layer) => warnings.filter((w) => w.layer === layer).map((w) => w.message).join('\n');
  assert.match(about(null), /^320x50: plays 48\.0 s in all \(12\.0 s × 4\), past the 30 s/m);
  assert.match(about(null), /^320x50: plays 4 times; display networks allow 3 at most/m);
  assert.match(about('headline'), /320x50 › headline: its text is [\d.]+ px \(shrunk to fit\), below the 10 px that reads/);
  assert.match(about('tiny'), /its text is 7 px, below the 10 px/);
  assert.match(about('spill'), /its text overflows its frame \(fit 'none'\)/);
  assert.match(about('edge'), /runs past the canvas's edge at rest/);
  assert.match(about('gone'), /is off the canvas and never comes into view/);
  assert.match(about('enters'), /is off the canvas at rest .* shown only while its animation brings it in/);
  const story = checkSize(normal, 'story');
  assert.equal(story.some((w) => w.layer === null), false, 'social sizes have no display play-time limit');
  assert.equal(story.some((w) => w.layer === 'headline'), false, 'the same text reads at the story size');
  assert.ok(checkSize(normal, '970x250').length > 0, 'a size the ad isn\'t made in yet can be checked');
});
