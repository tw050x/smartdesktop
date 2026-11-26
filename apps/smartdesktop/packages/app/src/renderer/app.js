import '@smartdesktop/ui/renderer/top-bar.css';
import { startTopBar } from '@smartdesktop/ui/renderer/top-bar.js';

// An app window's own page: its top bar (@smartdesktop/ui's top-bar.js), above the other apps' tabs.
startTopBar(window.smartdesktop);
