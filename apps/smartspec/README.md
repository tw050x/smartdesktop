# SmartSpec

Plan systems and define the contracts between them, with your own AI.

SmartSpec does two things:

1. **System schemas.** Describe the overall system of a business and the local system being
   worked on or built from scratch, so another agent can turn up, see what needs to be built,
   and act on the plan.
2. **Contracts.** Define the contracts between systems and provide a test suite for them that
   lives outside any system's codebase.

In both cases, an AI creates what the plan needs through tool calls. Another agent can then
retrieve the plan and either delegate it or act on it.

## Status

Early days: an AI can propose schemas, you accept them, and you open them level by level.
Contract testing isn't built yet.

## Development

```sh
npm install
npm start        # build the interface and run the app
npm test
```
