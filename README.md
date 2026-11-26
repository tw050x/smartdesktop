# SmartSuite

A family of Mac apps, each worked on with your own AI.

| App | What it's for | Website |
| --- | --- | --- |
| [SmartDoc](apps/smartdoc) | Reviewing and editing PDFs | [smartdoc.tw050x.net](https://smartdoc.tw050x.net) |
| [SmartSpec](apps/smartspec) | Designing systems as schematics, and testing their contracts | [smartspec.tw050x.net](https://smartspec.tw050x.net) |
| [SmartDesktop](apps/smartdesktop) | One chat with your own AI, across the apps | [smartdesktop.tw050x.net](https://smartdesktop.tw050x.net) |
| [SmartPrep](apps/smartprep) | Preparing for interviews, and learning anything unfamiliar | [smartprep.tw050x.net](https://smartprep.tw050x.net) |
| [SmartPlan](apps/smartplan) | Boards of lists and cards for planning work | [smartplan.tw050x.net](https://smartplan.tw050x.net) |
| [SmartAd](apps/smartad) | Designing adverts for the web | |
| [SmartStudio](apps/smartstudio) | Making music and video on your own generation server | |

Each app is in `apps/<app>`, with its own history, brought in from the repository it used to have
(tw050x/smartdoc, tw050x/smartspec…, kept for their earlier releases). Its tags are prefixed with
its name (`smartspec-v0.13.0`). Code the apps share will go in `packages/`.

Each app still builds, tests and runs from its own folder, as before:

```sh
cd apps/smartspec
npm install
npm test
npm start
```

All the apps are in beta.

## Licence

MIT, see [LICENSE](LICENSE).
