// What the website demo shows: a fictional CV with two drafts, an improvement review of the
// original (its findings quote the text, placed once the page is drawn) and a highlights review
// of Draft 1. The findings are the ones Draft 1 carries out.

import draftOnePdf from './cv-draft-1.pdf?url';
import originalPdf from './cv-original.pdf?url';

export const DOCUMENT = { id: 'demo', name: 'Alex Example CV.pdf', importedAt: '2026-10-12T09:00:00.000Z' };

export const DRAFTS = [
  { id: 'original', pdf: originalPdf, summary: null },
  { id: 'draft-1', pdf: draftOnePdf, summary: 'Rewrote the profile, led with what was built, added the checkout result and put Skills first.' },
];

export const IMPROVE = {
  draftId: 'original',
  type: 'improve',
  title: 'Make it stand out',
  goal: 'Make it stand out to a hiring manager',
  summary: 'Four changes to lead with results.',
  items: [
    {
      kind: 'options',
      title: 'Rewrite the profile',
      body: 'It’s the first thing read, and nothing in it is only true of you.',
      quotes: [{ page: 1, quote: 'Hard-working engineer with experience in many areas of software, looking for a new challenge. I have worked in a range of companies, from small teams to large organisations, and I enjoy solving problems and learning new technologies. I am a team player who also works well on my own, and I am always keen to take on more responsibility.' }],
      options: [
        { label: 'Lead with what you build', text: 'Engineering lead with twelve years in web development, the last six leading frontend platform work in online retail and travel. I build the shared tools that let product teams ship faster and more safely.' },
        { label: 'Lead with results', text: 'Frontend lead who halved build times, raised checkout conversion by 12% and grew a team through nine hires. Looking for a lead role on a platform team.' },
      ],
    },
    {
      kind: 'change',
      title: 'Lead with what you built',
      body: '“Responsible for” undersells it.',
      quotes: [{ page: 1, quote: 'Responsible for a design system used by 4 teams across 3 apps' }],
      proposal: { before: 'Responsible for a design system used by 4 teams across 3 apps', after: 'Built the design system 4 teams use across 3 apps' },
    },
    {
      kind: 'question',
      title: 'What came of the checkout work?',
      body: 'A result reads far stronger than “worked on”.',
      quotes: [{ page: 1, quote: 'Worked on the checkout' }],
      question: 'What changed after your work on the checkout? A number helps.',
    },
    {
      kind: 'move',
      title: 'Put Skills before Experience',
      body: 'Recruiters scan for the stack first.',
      quotes: [{ page: 1, quote: 'TypeScript, JavaScript, HTML, CSS, SQL' }], // the section's first line (its heading is letter-spaced in the PDF's text)
      proposal: { description: 'Move the Skills section up, under the profile.' },
    },
  ],
};

export const HIGHLIGHTS = {
  draftId: 'draft-1',
  type: 'highlights',
  title: 'Recruiter skim',
  goal: 'What a recruiter takes in at a glance',
  summary: 'A clear lead with results; the team size is missing.',
  highlights: [
    { category: 'Leadership', title: 'Six years leading platform work', importance: 'high', note: 'The level they’re hiring for, stated in the first line.', quotes: [{ page: 1, quote: 'Engineering lead with twelve years in web development, the last six leading frontend platform work in online retail and travel.' }] },
    { category: 'Impact', title: 'Conversion up 12%', importance: 'high', note: 'A measured result, the line most likely to be remembered.', quotes: [{ page: 1, quote: 'raising conversion by 12%' }] },
    { category: 'Impact', title: 'A design system 4 teams use', importance: 'medium', note: 'Shows reach beyond one team.', quotes: [{ page: 1, quote: 'Built the design system 4 teams use across 3 apps' }] },
    { category: 'Leadership', title: 'Developers promoted', importance: 'medium', note: 'Evidence of growing people, not just managing them.', quotes: [{ page: 1, quote: 'Mentored 5 developers, 2 of whom were promoted' }] },
    { category: 'Gaps', title: 'No team size', importance: 'medium', note: 'How many people Alex leads at Acme isn’t said.', quotes: [] },
  ],
};

// The variation made on the home screen: the CV tailored to one job, from Draft 1. Only its
// listing shows, so its own draft has no PDF.
export const VARIATION = {
  id: 'variation-acme',
  name: 'Acme product lead',
  purpose: 'Tailor it to the product lead role at Acme: leading a team of 6 on the design system.',
  fromDraft: 1,
  drafts: [{ id: 'draft-acme', summary: 'Led with the design system and the team, as the job spec asks.', review: { title: 'Acme product lead', decided: 3, findings: 5 } }],
};
