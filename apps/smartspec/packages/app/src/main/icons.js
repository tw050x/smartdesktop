// The icons a document or schematic can have, shown on its tab and on home (the user's choice: set by
// the user, or by the AI when it hasn't been, and until then guessed from the name: `guessIcon`).
// The same in both apps (SmartDoc's and SmartSpec's icons.js; keep the two alike). The drawings are
// Lucide's (lucide.dev, lucide-static 0.460.0), under its licence:
//
//   ISC License. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
//   Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or
//   without fee is hereby granted, provided that the above copyright notice and this permission
//   notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
//   WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
//   FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
//   CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
//   WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
//   CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// No DOM or Node here, so the main process (the AI's tools) and the windows can both use it.

// Each: its name (what's kept, and what the AI is given), what it's called, its drawing (a 24 by
// 24 Lucide drawing's insides), and words in a name that suggest it.
export const ICONS = [
  { name: "file-text", label: "Document", words: ["document", "doc", "report", "paper", "text", "notes"], svg: "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/><path d=\"M10 9H8\"/><path d=\"M16 13H8\"/><path d=\"M16 17H8\"/>" },
  { name: "contact", label: "CV", words: ["cv", "resume", "r\u00e9sum\u00e9", "profile", "bio"], svg: "<path d=\"M16 2v2\"/><path d=\"M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2\"/><path d=\"M8 2v2\"/><circle cx=\"12\" cy=\"11\" r=\"3\"/><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/>" },
  { name: "briefcase", label: "Work", words: ["job", "work", "career", "role", "application", "cover letter", "offer", "hiring"], svg: "<path d=\"M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\"/><rect width=\"20\" height=\"14\" x=\"2\" y=\"6\" rx=\"2\"/>" },
  { name: "graduation-cap", label: "Education", words: ["education", "school", "university", "course", "thesis", "study", "degree"], svg: "<path d=\"M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z\"/><path d=\"M22 10v6\"/><path d=\"M6 12.5V16a6 3 0 0 0 12 0v-3.5\"/>" },
  { name: "scale", label: "Legal", words: ["legal", "contract", "agreement", "terms", "policy", "law", "nda", "compliance"], svg: "<path d=\"m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z\"/><path d=\"m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z\"/><path d=\"M7 21h10\"/><path d=\"M12 3v18\"/><path d=\"M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2\"/>" },
  { name: "receipt", label: "Invoice", words: ["invoice", "receipt", "bill", "quote", "expense"], svg: "<path d=\"M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z\"/><path d=\"M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8\"/><path d=\"M12 17.5v-11\"/>" },
  { name: "landmark", label: "Finance", words: ["finance", "bank", "tax", "budget", "accounts", "funding"], svg: "<line x1=\"3\" x2=\"21\" y1=\"22\" y2=\"22\"/><line x1=\"6\" x2=\"6\" y1=\"18\" y2=\"11\"/><line x1=\"10\" x2=\"10\" y1=\"18\" y2=\"11\"/><line x1=\"14\" x2=\"14\" y1=\"18\" y2=\"11\"/><line x1=\"18\" x2=\"18\" y1=\"18\" y2=\"11\"/><polygon points=\"12 2 20 7 4 7\"/>" },
  { name: "presentation", label: "Presentation", words: ["presentation", "slides", "deck", "pitch"], svg: "<path d=\"M2 3h20\"/><path d=\"M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3\"/><path d=\"m7 21 5-5 5 5\"/>" },
  { name: "book-open", label: "Book", words: ["book", "chapter", "manual", "guide", "handbook", "story"], svg: "<path d=\"M12 7v14\"/><path d=\"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z\"/>" },
  { name: "newspaper", label: "Article", words: ["article", "news", "blog", "post", "press", "newsletter"], svg: "<path d=\"M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2\"/><path d=\"M18 14h-8\"/><path d=\"M15 18h-5\"/><path d=\"M10 6h8v4h-8V6Z\"/>" },
  { name: "mail", label: "Letter", words: ["letter", "email", "mail", "message"], svg: "<rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\"/><path d=\"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7\"/>" },
  { name: "clipboard-list", label: "Plan", words: ["plan", "proposal", "checklist", "spec", "requirements", "brief", "roadmap"], svg: "<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/><path d=\"M12 11h4\"/><path d=\"M12 16h4\"/><path d=\"M8 11h.01\"/><path d=\"M8 16h.01\"/>" },
  { name: "notebook-pen", label: "Notes", words: ["notes", "journal", "draft", "essay", "minutes"], svg: "<path d=\"M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4\"/><path d=\"M2 6h4\"/><path d=\"M2 10h4\"/><path d=\"M2 14h4\"/><path d=\"M2 18h4\"/><path d=\"M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z\"/>" },
  { name: "server", label: "Service", words: ["service", "server", "backend", "api", "microservice"], svg: "<rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\"/><rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\"/><line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\"/><line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\"/>" },
  { name: "database", label: "Data", words: ["data", "database", "storage", "store", "db", "warehouse", "records"], svg: "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M3 5V19A9 3 0 0 0 21 19V5\"/><path d=\"M3 12A9 3 0 0 0 21 12\"/>" },
  { name: "cloud", label: "Cloud", words: ["cloud", "hosting", "infrastructure", "aws", "deploy"], svg: "<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>" },
  { name: "network", label: "Network", words: ["network", "gateway", "routing", "mesh", "proxy", "load balancer"], svg: "<rect x=\"16\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/><rect x=\"2\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/><rect x=\"9\" y=\"2\" width=\"6\" height=\"6\" rx=\"1\"/><path d=\"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3\"/><path d=\"M12 12V8\"/>" },
  { name: "workflow", label: "Process", words: ["process", "workflow", "pipeline", "flow", "orchestration"], svg: "<rect width=\"8\" height=\"8\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M7 11v4a2 2 0 0 0 2 2h4\"/><rect width=\"8\" height=\"8\" x=\"13\" y=\"13\" rx=\"2\"/>" },
  { name: "blocks", label: "Module", words: ["module", "component", "library", "package", "sdk"], svg: "<rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\"/><path d=\"M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3\"/>" },
  { name: "layers", label: "Platform", words: ["platform", "system", "architecture", "stack", "overview"], svg: "<path d=\"m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z\"/><path d=\"m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65\"/><path d=\"m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65\"/>" },
  { name: "shield", label: "Security", words: ["security", "fraud", "risk", "protection", "firewall", "safety"], svg: "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/>" },
  { name: "key-round", label: "Auth", words: ["auth", "authentication", "login", "sign in", "token", "oauth", "identity", "sso", "credentials"], svg: "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\"/><circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>" },
  { name: "lock", label: "Privacy", words: ["privacy", "encryption", "secret", "permission", "access"], svg: "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>" },
  { name: "user", label: "Person", words: ["user", "account", "customer", "person", "member"], svg: "<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/>" },
  { name: "users", label: "Team", words: ["team", "users", "people", "community", "org", "organisation", "organization", "hr"], svg: "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>" },
  { name: "credit-card", label: "Payments", words: ["payment", "payments", "card", "billing", "charge", "refund", "subscription"], svg: "<rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\"/><line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\"/>" },
  { name: "shopping-cart", label: "Checkout", words: ["checkout", "cart", "basket", "order", "orders", "purchase", "shop"], svg: "<circle cx=\"8\" cy=\"21\" r=\"1\"/><circle cx=\"19\" cy=\"21\" r=\"1\"/><path d=\"M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12\"/>" },
  { name: "store", label: "Store", words: ["store", "retail", "marketplace", "catalogue", "catalog", "product", "products", "grocery"], svg: "<path d=\"m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7\"/><path d=\"M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8\"/><path d=\"M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4\"/><path d=\"M2 7h20\"/><path d=\"M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7\"/>" },
  { name: "package", label: "Inventory", words: ["inventory", "stock", "warehouse", "parcel", "fulfilment", "fulfillment"], svg: "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/><path d=\"M12 22V12\"/><path d=\"m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7\"/><path d=\"m7.5 4.27 9 5.15\"/>" },
  { name: "truck", label: "Delivery", words: ["delivery", "shipping", "logistics", "dispatch", "courier", "fleet"], svg: "<path d=\"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2\"/><path d=\"M15 18H9\"/><path d=\"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14\"/><circle cx=\"17\" cy=\"18\" r=\"2\"/><circle cx=\"7\" cy=\"18\" r=\"2\"/>" },
  { name: "bell", label: "Notifications", words: ["notification", "notifications", "alert", "alerts", "push"], svg: "<path d=\"M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9\"/><path d=\"M10.3 21a1.94 1.94 0 0 0 3.4 0\"/>" },
  { name: "message-square", label: "Messaging", words: ["chat", "messaging", "messages", "relay", "conversation", "support"], svg: "<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/>" },
  { name: "globe", label: "Web", words: ["web", "website", "site", "frontend", "portal", "browser"], svg: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/><path d=\"M2 12h20\"/>" },
  { name: "smartphone", label: "Mobile", words: ["mobile", "app", "ios", "android", "phone"], svg: "<rect width=\"14\" height=\"20\" x=\"5\" y=\"2\" rx=\"2\" ry=\"2\"/><path d=\"M12 18h.01\"/>" },
  { name: "monitor", label: "Desktop", words: ["desktop", "dashboard", "console", "admin", "screen"], svg: "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"/><line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"/><line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"/>" },
  { name: "search", label: "Search", words: ["search", "index", "discovery", "lookup", "query"], svg: "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>" },
  { name: "chart-line", label: "Analytics", words: ["analytics", "metrics", "reporting", "stats", "insights", "monitoring", "telemetry"], svg: "<path d=\"M3 3v16a2 2 0 0 0 2 2h16\"/><path d=\"m19 9-5 5-4-4-3 3\"/>" },
  { name: "calendar", label: "Schedule", words: ["calendar", "schedule", "booking", "bookings", "appointment", "event", "events"], svg: "<path d=\"M8 2v4\"/><path d=\"M16 2v4\"/><rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\"/><path d=\"M3 10h18\"/>" },
  { name: "clock", label: "Time", words: ["time", "timer", "cron", "job queue", "deadline"], svg: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/>" },
  { name: "map-pin", label: "Location", words: ["location", "map", "address", "geo", "places"], svg: "<path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\"/><circle cx=\"12\" cy=\"10\" r=\"3\"/>" },
  { name: "settings", label: "Settings", words: ["settings", "config", "configuration", "preferences", "admin"], svg: "<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>" },
  { name: "plug", label: "Integration", words: ["integration", "connector", "plugin", "webhook", "adapter"], svg: "<path d=\"M12 22v-5\"/><path d=\"M9 8V2\"/><path d=\"M15 8V2\"/><path d=\"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z\"/>" },
  { name: "git-branch", label: "Code", words: ["git", "repository", "repo", "branch", "ci", "build", "release"], svg: "<line x1=\"6\" x2=\"6\" y1=\"3\" y2=\"15\"/><circle cx=\"18\" cy=\"6\" r=\"3\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><path d=\"M18 9a9 9 0 0 1-9 9\"/>" },
  { name: "terminal", label: "Tool", words: ["cli", "command", "terminal", "script", "tool", "tooling"], svg: "<polyline points=\"4 17 10 11 4 5\"/><line x1=\"12\" x2=\"20\" y1=\"19\" y2=\"19\"/>" },
  { name: "cpu", label: "Compute", words: ["compute", "worker", "processing", "machine learning", "ml", "model", "ai"], svg: "<rect width=\"16\" height=\"16\" x=\"4\" y=\"4\" rx=\"2\"/><rect width=\"6\" height=\"6\" x=\"9\" y=\"9\" rx=\"1\"/><path d=\"M15 2v2\"/><path d=\"M15 20v2\"/><path d=\"M2 15h2\"/><path d=\"M2 9h2\"/><path d=\"M20 15h2\"/><path d=\"M20 9h2\"/><path d=\"M9 2v2\"/><path d=\"M9 20v2\"/>" },
  { name: "mail-check", label: "Email", words: ["email service", "smtp", "inbox", "mailing"], svg: "<path d=\"M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8\"/><path d=\"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7\"/><path d=\"m16 19 2 2 4-4\"/>" },
  { name: "building-2", label: "Business", words: ["business", "company", "enterprise", "office", "corporate"], svg: "<path d=\"M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z\"/><path d=\"M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2\"/><path d=\"M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2\"/><path d=\"M10 6h4\"/><path d=\"M10 10h4\"/><path d=\"M10 14h4\"/><path d=\"M10 18h4\"/>" },
  { name: "heart-pulse", label: "Health", words: ["health", "medical", "patient", "clinic", "care"], svg: "<path d=\"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z\"/><path d=\"M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27\"/>" },
  { name: "wallet", label: "Wallet", words: ["wallet", "balance", "ledger", "money"], svg: "<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\"/><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\"/>" },
  { name: "ticket", label: "Ticket", words: ["ticket", "tickets", "issue", "issues", "helpdesk"], svg: "<path d=\"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z\"/><path d=\"M13 5v2\"/><path d=\"M13 17v2\"/><path d=\"M13 11v2\"/>" },
  { name: "rocket", label: "Launch", words: ["launch", "startup", "onboarding", "getting started"], svg: "<path d=\"M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z\"/><path d=\"m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z\"/><path d=\"M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0\"/><path d=\"M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5\"/>" },
  { name: "sparkles", label: "Idea", words: ["idea", "ideas", "concept", "vision", "brainstorm"], svg: "<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\"/><path d=\"M20 3v4\"/><path d=\"M22 5h-4\"/><path d=\"M4 17v2\"/><path d=\"M5 18H3\"/>" },
  { name: "flag", label: "Goal", words: ["goal", "goals", "milestone", "okr", "objective"], svg: "<path d=\"M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z\"/><line x1=\"4\" x2=\"4\" y1=\"22\" y2=\"15\"/>" },
  { name: "star", label: "Favourite", words: ["favourite", "favorite", "important", "featured"], svg: "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\"/>" },
  { name: "zap", label: "Events", words: ["event bus", "stream", "streaming", "queue", "kafka", "pubsub", "trigger"], svg: "<path d=\"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z\"/>" },
  { name: "file", label: "File", words: [], svg: "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/>" },
];

const BY_NAME = new Map(ICONS.map((icon) => [icon.name, icon]));
export const isIcon = (name) => BY_NAME.has(name);

// An icon as SVG markup, `size` pixels square, in the text's colour.
export function iconSvg(name, size = 16) {
  const icon = BY_NAME.get(name) ?? BY_NAME.get('file');
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon.svg}</svg>`;
}

// The icon a name suggests (its words, or phrases, matched whole), or `fallback`.
export function guessIcon(text, fallback = 'file') {
  const words = ` ${String(text ?? '').toLowerCase().replace(/\.pdf$/, '').replace(/[^a-z0-9é]+/g, ' ')} `;
  let best = null;
  for (const icon of ICONS) {
    for (const word of icon.words) {
      if (!words.includes(` ${word} `)) continue;
      // The longest match wins ("cover letter" over "letter").
      if (!best || word.length > best.length) best = { name: icon.name, length: word.length };
    }
  }
  return best?.name ?? fallback;
}

// The icon a document or schematic shows: its own (the user's or the AI's), or the guess from its name.
export const iconFor = (chosen, name, fallback) => (isIcon(chosen?.icon) ? chosen.icon : guessIcon(name, fallback));
