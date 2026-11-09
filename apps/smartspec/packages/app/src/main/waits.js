// What an AI waits for, with `smartspec wait`: the user accepting or discarding a proposal, or
// sending it their comments on it to deal with first. The answer is kept, so one given before the
// wait began is still found.

// A wait that can't end, so it's refused rather than left hanging. `status` is the HTTP status the
// server answers with.
export class WaitRefused extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

// `store` says what became of a proposal, and its events say when something did.
export function createWaits({ store }) {
  async function look(id) {
    try {
      const outcome = await store.proposalOutcome(id);
      return outcome && { event: `proposal-${outcome.outcome}`, ...outcome };
    } catch (error) {
      throw new WaitRefused(error.message, 404);
    }
  }

  return {
    // { promise, cancel }: the promise gives what happened (null if cancelled), or fails if the wait
    // can't end.
    forProposal(id) {
      let cancel;
      const promise = new Promise((resolve, reject) => {
        let done = false;
        const finish = (settle, value) => {
          if (done) return;
          done = true;
          store.events.off('proposal', check);
          settle(value);
        };
        const check = () => look(id).then((result) => result && finish(resolve, result), (error) => finish(reject, error));
        cancel = () => finish(resolve, null);
        store.events.on('proposal', check);
        check();
      });
      return { promise, cancel };
    },
  };
}
