// The card for a new variation (File > New Variation…, or a draft's "New variation" on the home
// screen): what the variation is for, then a prompt to send the AI, which makes the variation
// from that draft and tailors it for the purpose.

const label = (number) => (number === 0 ? 'the original' : `Draft ${number}`);

export function createVariationCard({ dialog, api }) {
  const message = dialog.querySelector('#variation-message');
  const purpose = dialog.querySelector('#variation-purpose');
  const copy = dialog.querySelector('#variation-copy');
  let prompt = null;
  let closing; // the close after copying, cancelled if the card's opened again first

  purpose.addEventListener('input', () => (copy.disabled = !purpose.value.trim()));
  dialog.querySelector('#variation-cancel').addEventListener('click', () => dialog.close());
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api.copyText(prompt(purpose.value.trim()));
    copy.textContent = 'Copied';
    closing = setTimeout(() => dialog.close(), 800);
  });

  // { docId, docName, variationId, variationName, draft }: the draft by its number in the variation.
  return function open({ docId, docName, variationId, variationName, draft }) {
    clearTimeout(closing);
    const from = variationId === 'original' ? label(draft) : `${label(draft)} of ${variationName}`;
    message.textContent = `Your AI starts a variation from ${from} and tailors it from there. The other variations stay as they are.`;
    prompt = (text) => `Make a variation of “${docName}” (document ${docId}) in SmartDoc from ${label(draft)} of its “${variationName}” variation (${variationId}), and tailor it for: ${text}`;
    purpose.value = '';
    copy.disabled = true;
    copy.textContent = 'Copy the prompt';
    dialog.showModal();
    purpose.focus();
  };
}
