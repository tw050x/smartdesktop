// A prompt copied from a window names it, so the AI that gets it takes that window over.
export const promptNamingWindow = (prompt, windowId) => `${prompt} Take over SmartDoc window ${windowId} with use_window first.`;

// Said wherever a prompt can be copied: pasting it gives the AI this window.
export function takeOverNote(api) {
  if (!api.windowId) return null;
  const note = document.createElement('p');
  note.className = 'take-over-note';
  note.textContent = 'Your AI will take over this window when you send it the prompt.';
  return note;
}
