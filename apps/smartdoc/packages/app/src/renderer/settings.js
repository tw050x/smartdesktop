// SmartDoc's Settings: the dialog every app has (@smartdesktop/ui's settings.js: appearance and
// version), with SmartDoc's experimental features in it, off until turned on.
import { createSettings as createDialog } from '@smartdesktop/ui/renderer/settings.js';

export function createSettings({ dialog, api }) {
  // Experimental features (main.js keeps them), shown as they are each time Settings opens.
  const convert = dialog.querySelector('#experimental-convert');
  const showExperimental = () => api.getExperimental?.().then((x) => (convert.checked = Boolean(x?.convert)));
  convert.addEventListener('change', () => api.setExperimental('convert', convert.checked));
  showExperimental();
  createDialog({ dialog, api, name: 'SmartDoc', onOpen: showExperimental });
}
