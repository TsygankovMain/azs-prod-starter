/**
 * reasonCaptureStore — in-memory store that tracks "awaiting reason" state
 * per user/dialog. When a user presses the COMMAND «Указать причину» button,
 * the bot sets awaiting state here. The next plain-text message from that
 * user/dialog is treated as the reason and the state is cleared.
 *
 * Keyed by `${userId}:${dialogId}` so multiple portals/dialogs don't collide.
 */

const makeKey = ({ userId, dialogId }) =>
  `${String(userId || '')}:${String(dialogId || '')}`;

export const createReasonCaptureStore = () => {
  /** @type {Map<string, { reportId: number, azsId: string }>} */
  const map = new Map();

  return {
    /**
     * Record that the bot is waiting for a reason from this user/dialog.
     * @param {{ userId: number|string, dialogId: string, reportId: number, azsId: string }} opts
     */
    setAwaiting({ userId, dialogId, reportId, azsId }) {
      map.set(makeKey({ userId, dialogId }), {
        reportId: Number(reportId),
        azsId: String(azsId || '')
      });
    },

    /**
     * Retrieve waiting state, or null if not awaiting.
     * @param {{ userId: number|string, dialogId: string }} opts
     * @returns {{ reportId: number, azsId: string } | null}
     */
    getAwaiting({ userId, dialogId }) {
      return map.get(makeKey({ userId, dialogId })) ?? null;
    },

    /**
     * Remove awaiting state after the reason has been captured.
     * @param {{ userId: number|string, dialogId: string }} opts
     */
    clearAwaiting({ userId, dialogId }) {
      map.delete(makeKey({ userId, dialogId }));
    }
  };
};

export default createReasonCaptureStore;
