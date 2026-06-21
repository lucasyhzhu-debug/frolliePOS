// Manager-only "skip start-of-day" escape hatch (v1.2).
//
// A manager may bypass the mandatory start-of-day SOP and go straight to the
// menu. Normal staff CANNOT — the first staff of the day still walks the
// checklist (the RootLayout gate only honours this flag when role === "manager").
//
// The decision is persisted in sessionStorage keyed to the ACTIVE session id so
// it survives reloads within the tab (the SOP gate would otherwise re-trap a
// manager on a `closed` booth after every refresh) but resets on a new login or
// tab close. Keying on sessionId means a stale bypass can never leak into the
// next shift: sign-off ends the session, so the next login gets a fresh
// sessionId that this flag won't match.
//
// This is a deliberate layer ON TOP of best-effort `completeStartOfDay`: the
// mutation opens the booth properly when the backend is healthy, and this flag
// guarantees the manager is not trapped in the gate when it isn't (e.g. a
// throwing stale-shift auto-close — see RootLayout's SOP-gate comment).
const KEY = "frollie:mgr-skip-sod";

export function markManagerSkippedSOD(sessionId: string): void {
  try {
    sessionStorage.setItem(KEY, sessionId);
  } catch {
    /* private mode / storage disabled — non-fatal, gate just won't bypass */
  }
}

export function hasManagerSkippedSOD(sessionId: string): boolean {
  try {
    return sessionStorage.getItem(KEY) === sessionId;
  } catch {
    return false;
  }
}
