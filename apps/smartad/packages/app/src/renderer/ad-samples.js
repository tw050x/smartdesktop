// Two sample ads for Larder, the made-up grocery business the family's demos use: a still
// 300x250, and a 6 s animated ad in three sizes (300x250, 728x90 and a 9:16 story). For the
// preview page (ad-preview.html) and the tests; not part of the app. Written as the AI would
// write them: defaults left out, overrides only where a size needs its own layout.

const svg = (body, w, h) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`)}`;

const LOGO = svg(`
  <rect x="0" y="0" width="100" height="100" rx="24" fill="#2f7d4f"/>
  <path d="M32 30h36v8c6 4 8 9 8 16v18c0 7-5 11-11 11H35c-6 0-11-4-11-11V54c0-7 2-12 8-16z" fill="#fff"/>
  <rect x="30" y="22" width="40" height="10" rx="4" fill="#f6c453"/>
  <path d="M38 60c8-10 18-10 24 0-6 9-16 9-24 0z" fill="#2f7d4f"/>
  <text x="118" y="71" font-family="-apple-system, Helvetica Neue, sans-serif" font-size="60" font-weight="800" fill="#1d1d1f" letter-spacing="-1">Larder</text>`, 340, 100);

const PRODUCE = svg(`
  <ellipse cx="200" cy="345" rx="165" ry="22" fill="#000" opacity="0.12"/>
  <path d="M70 150c-20-55 25-90 60-70-5 35-30 55-60 70z" fill="#3f9b5c"/>
  <path d="M330 140c25-50-15-90-55-75 0 38 25 60 55 75z" fill="#2f7d4f"/>
  <ellipse cx="205" cy="160" rx="62" ry="44" fill="#f4d03f" transform="rotate(-18 205 160)"/>
  <circle cx="135" cy="215" r="66" fill="#f39c32"/>
  <circle cx="118" cy="195" r="10" fill="#fff" opacity="0.35"/>
  <circle cx="275" cy="205" r="64" fill="#d9483b"/>
  <path d="M275 142c2-14 8-22 18-26" stroke="#6b4423" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M282 136c14-14 30-12 36-4-12 10-26 10-36 4z" fill="#3f9b5c"/>
  <path d="M40 230h320c-8 70-70 115-160 115S48 300 40 230z" fill="#c98a5a"/>
  <path d="M40 230h320c-1 9-3 17-6 25H46c-3-8-5-16-6-25z" fill="#b5774a"/>`, 400, 380);

const ASSETS = { logo: LOGO, produce: PRODUCE };

// A URL for each sample asset, as the app gives one for the files it stores.
export const sampleAssetUrl = (id) => ASSETS[id] ?? null;

export const STILL_AD = {
  duration: 0,
  background: '#f6f1e7',
  sizes: ['300x250'],
  assets: [
    { id: 'logo', name: 'Larder logo', type: 'svg', width: 340, height: 100 },
    { id: 'produce', name: 'Bowl of fruit', type: 'svg', width: 400, height: 380 },
  ],
  layers: [
    { id: 'blob', name: 'Green backdrop', kind: 'shape', shape: 'ellipse', frame: { x: 0.48, y: 0.32, w: 0.8, h: 0.95 }, style: { background: '#2f7d4f' } },
    { id: 'produce', name: 'Fruit', kind: 'image', asset: 'produce', frame: { x: 0.5, y: 0.4, w: 0.52, h: 0.56 }, style: { fit: 'contain' } },
    { id: 'logo', name: 'Logo', kind: 'image', asset: 'logo', frame: { x: 0.06, y: 0.07, w: 0.34, h: 0.1 }, style: { fit: 'contain' } },
    { id: 'headline', name: 'Headline', kind: 'text', text: 'Your weekly shop, sorted.', frame: { x: 0.06, y: 0.24, w: 0.5, h: 0.3 }, style: { weight: 800, size: 0.085, lineHeight: 1.05, letterSpacing: -0.01 } },
    { id: 'subline', name: 'Subline', kind: 'text', text: 'Local shops, at your door in an hour.', frame: { x: 0.06, y: 0.55, w: 0.42, h: 0.16 }, style: { size: 0.045, color: '#4a4a4f' } },
    { id: 'cta', name: 'Call to action', kind: 'button', text: 'Start your shop', frame: { x: 0.06, y: 0.76, w: 0.4, h: 0.13 }, style: { background: '#e8553d', radius: 0.5, shadow: true } },
  ],
};

export const ANIMATED_AD = {
  duration: 6,
  loops: 2,
  background: '#f6f1e7',
  sizes: ['300x250', '728x90', 'story'],
  assets: [
    { id: 'logo', name: 'Larder logo', type: 'svg', width: 340, height: 100 },
    { id: 'produce', name: 'Bowl of fruit', type: 'svg', width: 400, height: 380 },
  ],
  layers: [
    {
      id: 'blob', name: 'Green backdrop', kind: 'shape', shape: 'ellipse',
      frame: { x: 0.42, y: 0.3, w: 0.85, h: 1 },
      style: { background: 'linear-gradient(160deg, #3f9b5c, #2f7d4f)' },
      animation: { scale: [{ t: 0, value: 0.6 }, { t: 0.9, value: 1, ease: 'out' }], opacity: [{ t: 0, value: 0 }, { t: 0.4, value: 1 }] },
      sizes: {
        '728x90': { frame: { x: 0.6, y: -0.6, w: 0.32, h: 2.2 } },
        story: { frame: { x: 0.04, y: 0.44, w: 1.1, h: 0.64 } },
      },
    },
    {
      id: 'produce', name: 'Fruit', kind: 'image', asset: 'produce',
      frame: { x: 0.46, y: 0.36, w: 0.58, h: 0.62 }, style: { fit: 'contain' },
      animation: { x: [{ t: 0.2, value: 0.25 }, { t: 1, value: 0, ease: 'out' }], opacity: [{ t: 0.2, value: 0 }, { t: 0.6, value: 1 }] },
      sizes: {
        '728x90': { frame: { x: 0.62, y: 0.04, w: 0.22, h: 0.92 } },
        story: { frame: { x: 0.12, y: 0.45, w: 0.8, h: 0.38 } },
      },
    },
    {
      id: 'logo', name: 'Logo', kind: 'image', asset: 'logo',
      frame: { x: 0.06, y: 0.07, w: 0.34, h: 0.1 }, style: { fit: 'contain' },
      animation: { opacity: [{ t: 0, value: 0 }, { t: 0.5, value: 1 }] },
      sizes: {
        '728x90': { frame: { x: 0.02, y: 0.32, w: 0.14, h: 0.36 } },
        story: { frame: { x: 0.08, y: 0.06, w: 0.42, h: 0.065 } },
      },
    },
    {
      id: 'rule', name: 'Rule', kind: 'shape', shape: 'line',
      frame: { x: 0.06, y: 0.19, w: 0.14, h: 0.02 }, style: { background: '#e8553d', thickness: 0.01, radius: 0.5 },
      animation: { reveal: [{ t: 0.3, value: 0 }, { t: 0.8, value: 1, ease: 'out' }] },
      sizes: {
        '728x90': { hidden: true },
        story: { frame: { x: 0.08, y: 0.155, w: 0.16, h: 0.01 } },
      },
    },
    {
      id: 'headline', name: 'Headline', kind: 'text', text: 'Fresh food at your door in an hour',
      frame: { x: 0.06, y: 0.24, w: 0.5, h: 0.42 },
      style: { weight: 800, size: 0.085, lineHeight: 1.05, letterSpacing: -0.01 },
      until: 3.3,
      animation: {
        reveal: [{ t: 0.5, value: 0 }, { t: 1.4, value: 1, ease: 'linear' }],
        opacity: [{ t: 2.9, value: 1 }, { t: 3.3, value: 0, ease: 'in' }],
        y: [{ t: 2.9, value: 0 }, { t: 3.3, value: -0.04, ease: 'in' }],
      },
      sizes: {
        '728x90': { frame: { x: 0.19, y: 0.12, w: 0.4, h: 0.76 }, style: { valign: 'middle', size: 0.09 } },
        story: { frame: { x: 0.08, y: 0.18, w: 0.84, h: 0.25 } },
      },
    },
    {
      id: 'offer', name: 'Offer', kind: 'text', text: 'Free delivery on your first order',
      frame: { x: 0.06, y: 0.24, w: 0.5, h: 0.42 },
      style: { weight: 800, size: 0.085, lineHeight: 1.05, letterSpacing: -0.01, color: '#2f7d4f' },
      from: 3.1,
      animation: {
        opacity: [{ t: 3.1, value: 0 }, { t: 3.6, value: 1 }],
        y: [{ t: 3.1, value: 0.06 }, { t: 3.7, value: 0, ease: 'out' }],
      },
      sizes: {
        '728x90': { frame: { x: 0.19, y: 0.12, w: 0.4, h: 0.76 }, style: { valign: 'middle', size: 0.09 } },
        story: { frame: { x: 0.08, y: 0.18, w: 0.84, h: 0.25 } },
      },
    },
    {
      id: 'cta', name: 'Call to action', kind: 'button', text: 'Order now',
      frame: { x: 0.06, y: 0.75, w: 0.36, h: 0.14 },
      style: { background: '#e8553d', radius: 0.5, shadow: { y: 0.006, blur: 0.016, color: 'rgba(120, 40, 20, 0.3)' } },
      animation: {
        scale: [
          { t: 1.3, value: 0 }, { t: 1.8, value: 1, ease: 'back-out' },
          { t: 4.6, value: 1 }, { t: 4.85, value: 1.08 }, { t: 5.1, value: 1 },
        ],
        opacity: [{ t: 1.3, value: 0 }, { t: 1.45, value: 1, ease: 'linear' }],
      },
      sizes: {
        '728x90': { frame: { x: 0.855, y: 0.26, w: 0.13, h: 0.48 } },
        story: { frame: { x: 0.08, y: 0.87, w: 0.84, h: 0.075 } },
      },
    },
  ],
};

// Things to show on the animated ad's timeline: two comments and a proposal's changes.
export const SAMPLE_MARKS = [
  { t: 1.6, layer: 'cta', state: 'open' },
  { from: 2.9, to: 3.7, state: 'answered' },
  { from: 0.5, to: 1.4, layer: 'headline', kind: 'changed' },
  { from: 3.1, to: 6, layer: 'offer', kind: 'added' },
  { from: 0, to: 2, layer: 'badge', kind: 'removed' },
];

export const SAMPLES = { still: STILL_AD, animated: ANIMATED_AD };
