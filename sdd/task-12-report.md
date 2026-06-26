# Task 12 Review-Fix Report

## Fix 1 — begin.test.tsx (5 cases)

File: `src/routes/shift/__tests__/begin.test.tsx`

Cases:
1. **renders the wizard title** — asserts `<heading>Begin shift</heading>` present when `outletOpen=true, holderStaffId=null`
2. **renders the count step** — asserts `count-step-stub` in document
3. **happy path** — CountStep stub calls `onSubmitted(5)`, clicks terminal "Start shift" button, asserts `startShift` called once with `{ idempotencyKey: "idem-key-begin", sessionId: "session_abc", steps: [{type:"count"}], openCount: 5 }` and `navigate("/", { replace: true })`
4. **stray-visit guard A** (`outletOpen=false`) — asserts `count-step-stub` absent, `startShift` never called
5. **stray-visit guard B** (`holderStaffId !== null`) — asserts `count-step-stub` absent, `startShift` never called

Test run:
```
✓ src/routes/shift/__tests__/begin.test.tsx (5 tests) 146ms
✓ src/routes/shift/__tests__/start.test.tsx (10 tests) 2366ms
Test Files  2 passed (2)
Tests       15 passed (15)
```

## Fix 2 — start.tsx onSkipPin guard

File: `src/routes/shift/start.tsx`, line 132

Changed:
```
- setSkipPinError(t("shiftStart.skipPinLabel")); // was: field label "Enter manager PIN"
+ setSkipPinError(t("lock.errorNotReady"));       // correct: "Device or manager not ready."
```

`lock.errorNotReady` confirmed present in both `en.ts` (line 639) and `id.ts` (line 637).

## Gates

- `npm run typecheck` → clean (0 errors)
- `npm run lint` → 0 errors, 14 warnings (pre-existing)
- `npx vitest run begin.test.tsx start.test.tsx` → 15/15 pass

## Commit

SHA: `8b0a071`
Subject: `test(fe): add /shift/begin route tests; fix skip-PIN not-ready error copy`
