import { startApp } from './app-shell.js';

// The app's window: the interface, working through the preload script's API (see preload.cjs).
startApp(window.smartdoc);
