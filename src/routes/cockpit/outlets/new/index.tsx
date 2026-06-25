/**
 * /cockpit/outlets/new — multi-step new-outlet wizard (v1.3.0 Task 11).
 *
 * 8-step in-component useReducer state machine (no router sub-routes per step).
 * Steps: 0 Mode · 1 Name+Code · 2 Address · 3 Timezone · 4 Bank/Receipt ·
 *        5 Staff access · 6 Telegram · 7 Review/Create.
 *
 * Design: amber/gold .theme-owner applied by RootLayout — semantic tokens only
 * (ADR-047). Inline field errors via <FieldMessage> (ADR-048). Brand strings as
 * {"…"} (ADR-049). Framer Motion guarded with useReducedMotion.
 */
import { useReducer, useState } from "react";
import { useNavigate } from "react-router";
import { useAction, useQuery } from "convex/react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { useSession } from "@/hooks/useSession";
import { useIdempotency, clearIntent } from "@/hooks/useIdempotency";
import { useOutletContext } from "@/contexts/OutletContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FieldMessage } from "@/components/ui/field-message";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { stepSlideVariants } from "@/lib/motion";
import type { TranslationKey } from "@/lib/i18n";

// ── Local types ────────────────────────────────────────────────────────────────

type OutletRow = {
  _id: Id<"outlets">;
  code: string;
  name: string;
  address?: string;
  timezone: string;
  active: boolean;
  created_at: number;
};

type StaffRow = {
  _id: Id<"staff">;
  name: string;
  code: string;
  role: "staff" | "manager" | "owner";
};

// ── Wizard state + reducer ─────────────────────────────────────────────────────

interface WizardState {
  step: number;
  mode: "blank" | "clone";
  source_outlet_id: Id<"outlets"> | undefined;
  name: string;
  code: string;
  address: string;
  timezone: string;
  receipt_business_name: string;
  receipt_address: string;
  receipt_contact: string;
  manual_bca_enabled: boolean;
  manual_bca_bank_name: string;
  manual_bca_account_name: string;
  manual_bca_account_number: string;
  staff_ids: Id<"staff">[];
  provision_managers_chat: boolean;
}

const INITIAL_STATE: WizardState = {
  step: 0,
  mode: "blank",
  source_outlet_id: undefined,
  name: "",
  code: "",
  address: "",
  timezone: "Asia/Jakarta",
  receipt_business_name: "",
  receipt_address: "",
  receipt_contact: "",
  manual_bca_enabled: false,
  manual_bca_bank_name: "",
  manual_bca_account_name: "",
  manual_bca_account_number: "",
  staff_ids: [],
  provision_managers_chat: false,
};

type WizardAction =
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "SET_MODE"; mode: "blank" | "clone" }
  | { type: "SET_SOURCE"; id: Id<"outlets"> | undefined; sourceName?: string; sourceAddress?: string }
  | { type: "SET_FIELD"; field: "name" | "code" | "address" | "timezone" | "receipt_business_name" | "receipt_address" | "receipt_contact" | "manual_bca_enabled" | "manual_bca_bank_name" | "manual_bca_account_name" | "manual_bca_account_number" | "provision_managers_chat"; value: string | boolean }
  | { type: "TOGGLE_STAFF_ID"; id: Id<"staff"> };

function reducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case "NEXT": return { ...s, step: Math.min(s.step + 1, 7) };
    case "BACK": return { ...s, step: Math.max(s.step - 1, 0) };
    case "SET_MODE":
      return {
        ...s,
        mode: a.mode,
        source_outlet_id: a.mode === "blank" ? undefined : s.source_outlet_id,
        // Clear clone-prefilled branding fields so a blank outlet never silently
        // inherits the previously-picked source's receipt settings (fix #2).
        receipt_business_name: a.mode === "blank" ? "" : s.receipt_business_name,
        receipt_address: a.mode === "blank" ? "" : s.receipt_address,
      };
    case "SET_SOURCE":
      return {
        ...s,
        source_outlet_id: a.id,
        // Best-effort UI prefill — BE clone is authoritative (task brief).
        receipt_business_name: a.sourceName ?? s.receipt_business_name,
        receipt_address: a.sourceAddress ?? s.receipt_address,
      };
    case "SET_FIELD":
      return { ...s, [a.field]: a.field === "code" ? String(a.value).toUpperCase() : a.value };
    case "TOGGLE_STAFF_ID": {
      const ids = s.staff_ids.includes(a.id)
        ? s.staff_ids.filter((id) => id !== a.id)
        : [...s.staff_ids, a.id];
      return { ...s, staff_ids: ids };
    }
    default: return s;
  }
}

// ── Step metadata ──────────────────────────────────────────────────────────────

const STEP_LABEL_KEYS: readonly TranslationKey[] = [
  "cockpitOutletNew.stepMode",
  "cockpitOutletNew.stepName",
  "cockpitOutletNew.stepAddress",
  "cockpitOutletNew.stepTimezone",
  "cockpitOutletNew.stepSettings",
  "cockpitOutletNew.stepStaff",
  "cockpitOutletNew.stepTelegram",
  "cockpitOutletNew.stepReview",
];

const TOTAL_STEPS = STEP_LABEL_KEYS.length; // 8

// ── Main component ─────────────────────────────────────────────────────────────

export default function CockpitOutletNew() {
  const t = useT();
  const navigate = useNavigate();
  const session = useSession();
  const { outlets, setCurrentOutlet } = useOutletContext();
  const createOutlet = useAction(api.cockpit.outlets.createOutlet);
  const idemKey = useIdempotency("cockpit:create-outlet");
  const reduce = useReducedMotion() ?? false;

  const sessionId = session.status === "active" ? session.sessionId : undefined;

  const staffList = useQuery(
    api.cockpit.outlets.listAssignableStaff,
    sessionId ? { sessionId } : "skip",
  );

  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [dir, setDir] = useState<1 | -1>(1);
  const [submitting, setSubmitting] = useState(false);

  // Existing outlet codes — derive uniqueness check for step 1.
  const existingCodes = (outlets ?? []).map((o) => o.code.toUpperCase());
  const isDupCode =
    state.code.trim() !== "" &&
    existingCodes.includes(state.code.trim().toUpperCase());

  // Per-step Next gate.
  const canNext =
    state.step === 0
      ? state.mode === "blank" || state.source_outlet_id !== undefined
      : state.step === 1
        ? state.name.trim() !== "" && state.code.trim() !== "" && !isDupCode
        : true;

  function goNext() {
    if (!canNext) return;
    setDir(1);
    dispatch({ type: "NEXT" });
  }

  function goBack() {
    setDir(-1);
    dispatch({ type: "BACK" });
  }

  async function handleCreate() {
    if (!idemKey || session.status !== "active") return;
    setSubmitting(true);
    const trim = (v: string) => v.trim() || undefined;
    try {
      const result = await createOutlet({
        idempotencyKey: idemKey,
        sessionId: session.sessionId,
        mode: state.mode,
        source_outlet_id: state.source_outlet_id,
        name: state.name.trim(),
        code: state.code.trim().toUpperCase(),
        address: trim(state.address),
        timezone: state.timezone,
        settings: {
          receipt_business_name: trim(state.receipt_business_name),
          receipt_address: trim(state.receipt_address),
          receipt_contact: trim(state.receipt_contact),
          manual_bca_enabled: state.manual_bca_enabled || undefined,
          manual_bca_bank_name: trim(state.manual_bca_bank_name),
          manual_bca_account_name: trim(state.manual_bca_account_name),
          manual_bca_account_number: trim(state.manual_bca_account_number),
        },
        staff_ids: state.staff_ids,
        provision_managers_chat: state.provision_managers_chat,
      });
      setCurrentOutlet(result.outlet_id as Id<"outlets">);
      await clearIntent("cockpit:create-outlet");
      navigate("/cockpit/outlets");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const isLastStep = state.step === TOTAL_STEPS - 1;

  return (
    <SpokeLayout title={t("cockpitOutletNew.title")} backTo="/cockpit/outlets">
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Progress bar */}
        <div className="h-0.5 bg-border" role="progressbar" aria-valuenow={state.step} aria-valuemax={TOTAL_STEPS - 1}>
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${(state.step / (TOTAL_STEPS - 1)) * 100}%` }}
          />
        </div>

        {/* Step header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {state.step + 1} / {TOTAL_STEPS}
          </span>
          <span className="text-sm font-semibold text-foreground" data-testid="step-label">
            {t(STEP_LABEL_KEYS[state.step]!)}
          </span>
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={state.step}
              variants={stepSlideVariants(dir, reduce)}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="p-4"
            >
              {state.step === 0 && (
                <StepMode state={state} dispatch={dispatch} outlets={outlets} t={t} />
              )}
              {state.step === 1 && (
                <StepNameCode state={state} dispatch={dispatch} isDupCode={isDupCode} t={t} />
              )}
              {state.step === 2 && (
                <StepAddress state={state} dispatch={dispatch} t={t} />
              )}
              {state.step === 3 && (
                <StepTimezone state={state} dispatch={dispatch} t={t} />
              )}
              {state.step === 4 && (
                <StepSettings state={state} dispatch={dispatch} t={t} />
              )}
              {state.step === 5 && (
                <StepStaff state={state} dispatch={dispatch} staffList={staffList} t={t} />
              )}
              {state.step === 6 && (
                <StepTelegram state={state} dispatch={dispatch} t={t} />
              )}
              {state.step === 7 && (
                <StepReview state={state} outlets={outlets} staffList={staffList} t={t} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Navigation */}
        <div className="flex gap-3 border-t border-border px-4 py-3">
          <Button
            variant="ghost"
            className="flex-1"
            onClick={goBack}
            disabled={state.step === 0}
            data-testid="btn-back"
          >
            {t("cockpitOutletNew.back")}
          </Button>
          {!isLastStep ? (
            <Button
              className="flex-1"
              onClick={goNext}
              disabled={!canNext}
              data-testid="btn-next"
            >
              {t("cockpitOutletNew.next")}
            </Button>
          ) : (
            <Button
              className="flex-1"
              onClick={handleCreate}
              disabled={submitting || !idemKey}
              data-testid="btn-create"
            >
              {submitting ? t("cockpitOutletNew.creating") : t("cockpitOutletNew.create")}
            </Button>
          )}
        </div>
      </div>
    </SpokeLayout>
  );
}

// ── Step sub-components ────────────────────────────────────────────────────────

type TFn = ReturnType<typeof useT>;

// ── Step 0: Mode ───────────────────────────────────────────────────────────────

function StepMode({
  state,
  dispatch,
  outlets,
  t,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  outlets: OutletRow[] | undefined;
  t: TFn;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => dispatch({ type: "SET_MODE", mode: "blank" })}
        className={`w-full rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          state.mode === "blank"
            ? "border-primary bg-primary/10"
            : "border-border hover:border-primary/40"
        }`}
        data-testid="mode-blank"
      >
        <p className="text-sm font-medium leading-snug text-foreground">
          {t("cockpitOutletNew.modeBlank")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("cockpitOutletNew.modeBlankDesc")}
        </p>
      </button>

      <button
        type="button"
        onClick={() => dispatch({ type: "SET_MODE", mode: "clone" })}
        className={`w-full rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          state.mode === "clone"
            ? "border-primary bg-primary/10"
            : "border-border hover:border-primary/40"
        }`}
        data-testid="mode-clone"
      >
        <p className="text-sm font-medium leading-snug text-foreground">
          {t("cockpitOutletNew.modeClone")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("cockpitOutletNew.modeCloneDesc")}
        </p>
      </button>

      {state.mode === "clone" && (
        <div className="space-y-2 pt-1">
          <p className="text-xs font-medium text-muted-foreground">
            {t("cockpitOutletNew.sourceOutletLabel")}
          </p>
          {outlets === undefined ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : outlets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("cockpitOutlets.empty")}</p>
          ) : (
            <div className="space-y-1.5">
              {outlets.map((o) => (
                <button
                  key={String(o._id)}
                  type="button"
                  onClick={() =>
                    dispatch({
                      type: "SET_SOURCE",
                      id: o._id,
                      sourceName: o.name,
                      sourceAddress: o.address,
                    })
                  }
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                    state.source_outlet_id === o._id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/40"
                  }`}
                  data-testid={`source-${o.code}`}
                >
                  <span className="font-medium text-foreground">{o.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{o.code}</span>
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("cockpitOutletNew.cloneNote")}</p>
        </div>
      )}
    </div>
  );
}

// ── Step 1: Name + Code ────────────────────────────────────────────────────────

function StepNameCode({
  state,
  dispatch,
  isDupCode,
  t,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  isDupCode: boolean;
  t: TFn;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="outlet-name">{t("cockpitOutletNew.nameLabel")}</Label>
        <Input
          id="outlet-name"
          value={state.name}
          onChange={(e) => dispatch({ type: "SET_FIELD", field: "name", value: e.target.value })}
          placeholder={t("cockpitOutletNew.namePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="outlet-code">{t("cockpitOutletNew.codeLabel")}</Label>
        <Input
          id="outlet-code"
          value={state.code}
          onChange={(e) => dispatch({ type: "SET_FIELD", field: "code", value: e.target.value })}
          placeholder={t("cockpitOutletNew.codePlaceholder")}
          autoComplete="off"
          className="font-mono uppercase"
        />
        <p className="text-xs text-muted-foreground">{t("cockpitOutletNew.codeHint")}</p>
        {isDupCode && (
          <FieldMessage tone="error">{t("cockpitOutletNew.codeDup")}</FieldMessage>
        )}
      </div>
    </div>
  );
}

// ── Step 2: Address ────────────────────────────────────────────────────────────

function StepAddress({
  state,
  dispatch,
  t,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  t: TFn;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="outlet-address">{t("cockpitOutletNew.addressLabel")}</Label>
      <Input
        id="outlet-address"
        value={state.address}
        onChange={(e) => dispatch({ type: "SET_FIELD", field: "address", value: e.target.value })}
        placeholder={t("cockpitOutletNew.addressPlaceholder")}
        autoComplete="street-address"
      />
      <p className="text-xs text-muted-foreground">{t("cockpitOutletNew.addressHint")}</p>
    </div>
  );
}

// ── Step 3: Timezone ───────────────────────────────────────────────────────────

function StepTimezone({
  state,
  dispatch,
  t,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  t: TFn;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="outlet-timezone">{t("cockpitOutletNew.timezoneLabel")}</Label>
      <Input
        id="outlet-timezone"
        value={state.timezone}
        onChange={(e) => dispatch({ type: "SET_FIELD", field: "timezone", value: e.target.value })}
        placeholder="Asia/Jakarta"
        autoComplete="off"
      />
      <p className="text-xs text-muted-foreground">{t("cockpitOutletNew.timezoneHint")}</p>
    </div>
  );
}

// ── Step 4: Bank + Receipt settings ───────────────────────────────────────────

function StepSettings({
  state,
  dispatch,
  t,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  t: TFn;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="receipt-business-name">
          {t("cockpitOutletNew.settingsReceiptBusinessName")}
        </Label>
        <Input
          id="receipt-business-name"
          value={state.receipt_business_name}
          onChange={(e) =>
            dispatch({ type: "SET_FIELD", field: "receipt_business_name", value: e.target.value })
          }
          placeholder={state.name || t("cockpitOutletNew.namePlaceholder")}
          autoComplete="organization"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="receipt-address">
          {t("cockpitOutletNew.settingsReceiptAddress")}
        </Label>
        <Input
          id="receipt-address"
          value={state.receipt_address}
          onChange={(e) =>
            dispatch({ type: "SET_FIELD", field: "receipt_address", value: e.target.value })
          }
          placeholder={state.address || t("cockpitOutletNew.addressPlaceholder")}
          autoComplete="street-address"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="receipt-contact">
          {t("cockpitOutletNew.settingsReceiptContact")}
        </Label>
        <Input
          id="receipt-contact"
          value={state.receipt_contact}
          onChange={(e) =>
            dispatch({ type: "SET_FIELD", field: "receipt_contact", value: e.target.value })
          }
          placeholder="e.g. 08123456789"
          autoComplete="tel"
        />
      </div>

      {/* Manual BCA section */}
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="bca-enabled" className="cursor-pointer">
            {t("cockpitOutletNew.settingsManualBcaEnabled")}
          </Label>
          <Switch
            id="bca-enabled"
            checked={state.manual_bca_enabled}
            onCheckedChange={() => dispatch({ type: "SET_FIELD", field: "manual_bca_enabled", value: !state.manual_bca_enabled })}
          />
        </div>

        {state.manual_bca_enabled && (
          <div className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <Label htmlFor="bca-bank-name">
                {t("cockpitOutletNew.settingsBcaBankName")}
              </Label>
              <Input
                id="bca-bank-name"
                value={state.manual_bca_bank_name}
                onChange={(e) =>
                  dispatch({ type: "SET_FIELD", field: "manual_bca_bank_name", value: e.target.value })
                }
                placeholder="BCA"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bca-account-name">
                {t("cockpitOutletNew.settingsBcaAccountName")}
              </Label>
              <Input
                id="bca-account-name"
                value={state.manual_bca_account_name}
                onChange={(e) =>
                  dispatch({ type: "SET_FIELD", field: "manual_bca_account_name", value: e.target.value })
                }
                placeholder="PT Frollie Indonesia"
                autoComplete="name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bca-account-number">
                {t("cockpitOutletNew.settingsBcaAccountNumber")}
              </Label>
              <Input
                id="bca-account-number"
                value={state.manual_bca_account_number}
                onChange={(e) =>
                  dispatch({ type: "SET_FIELD", field: "manual_bca_account_number", value: e.target.value })
                }
                placeholder="1234567890"
                autoComplete="off"
                inputMode="numeric"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 5: Staff access ───────────────────────────────────────────────────────

function StepStaff({
  state,
  dispatch,
  staffList,
  t,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  staffList: StaffRow[] | undefined;
  t: TFn;
}) {
  if (staffList === undefined) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (staffList.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("cockpitOutletNew.noStaff")}</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("cockpitOutletNew.staffHint")}</p>
      <div className="space-y-1.5">
        {staffList.map((s) => {
          const selected = state.staff_ids.includes(s._id);
          return (
            <button
              key={String(s._id)}
              type="button"
              onClick={() => dispatch({ type: "TOGGLE_STAFF_ID", id: s._id })}
              className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                selected
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/40"
              }`}
              data-testid={`staff-${s.code}`}
              aria-pressed={selected}
            >
              <span
                className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                  selected ? "border-primary bg-primary" : "border-muted-foreground"
                }`}
                aria-hidden="true"
              >
                {selected && (
                  <svg
                    className="size-3 text-primary-foreground"
                    viewBox="0 0 12 12"
                    fill="none"
                  >
                    <path
                      d="M2 6l3 3 5-5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-foreground">{s.name}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{s.code}</span>
              </span>
              <span className="shrink-0 text-xs capitalize text-muted-foreground">
                {s.role}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 6: Telegram ───────────────────────────────────────────────────────────

function StepTelegram({
  state,
  dispatch,
  t,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  t: TFn;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <Label htmlFor="telegram-provision" className="cursor-pointer leading-snug">
          {t("cockpitOutletNew.telegramToggleLabel")}
        </Label>
        <Switch
          id="telegram-provision"
          checked={state.provision_managers_chat}
          onCheckedChange={(v) => dispatch({ type: "SET_FIELD", field: "provision_managers_chat", value: v })}
        />
      </div>

      {state.provision_managers_chat && (
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("cockpitOutletNew.telegramHint")}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Step 7: Review ─────────────────────────────────────────────────────────────

function StepReview({
  state,
  outlets,
  staffList,
  t,
}: {
  state: WizardState;
  outlets: OutletRow[] | undefined;
  staffList: StaffRow[] | undefined;
  t: TFn;
}) {
  const sourceOutlet = state.source_outlet_id
    ? (outlets ?? []).find((o) => o._id === state.source_outlet_id)
    : undefined;

  const selectedStaff =
    state.staff_ids.length > 0 && staffList
      ? staffList.filter((s) => state.staff_ids.includes(s._id))
      : [];

  return (
    <dl className="space-y-3 text-sm">
      <ReviewRow label={t("cockpitOutletNew.reviewMode")}>
        {state.mode === "clone" ? t("cockpitOutletNew.modeClone") : t("cockpitOutletNew.modeBlank")}
      </ReviewRow>

      {state.mode === "clone" && (
        <ReviewRow label={t("cockpitOutletNew.reviewSource")}>
          {sourceOutlet ? `${sourceOutlet.name} (${sourceOutlet.code})` : t("cockpitOutletNew.reviewNone")}
        </ReviewRow>
      )}

      <ReviewRow label={t("cockpitOutletNew.reviewName")}>{state.name}</ReviewRow>
      <ReviewRow label={t("cockpitOutletNew.reviewCode")}>
        <span className="font-mono">{state.code}</span>
      </ReviewRow>

      {state.address && (
        <ReviewRow label={t("cockpitOutletNew.reviewAddress")}>{state.address}</ReviewRow>
      )}

      <ReviewRow label={t("cockpitOutletNew.reviewTimezone")}>{state.timezone}</ReviewRow>

      <ReviewRow label={t("cockpitOutletNew.reviewReceiptBusinessName")}>
        {state.receipt_business_name || t("cockpitOutletNew.reviewNone")}
      </ReviewRow>

      {state.manual_bca_enabled && (
        <ReviewRow label={t("cockpitOutletNew.reviewManualBca")}>
          {[state.manual_bca_bank_name, state.manual_bca_account_name, state.manual_bca_account_number]
            .filter(Boolean)
            .join(" · ") || t("cockpitOutletNew.reviewNone")}
        </ReviewRow>
      )}

      <ReviewRow label={t("cockpitOutletNew.reviewStaff")}>
        {selectedStaff.length > 0
          ? selectedStaff.map((s) => s.name).join(", ")
          : t("cockpitOutletNew.reviewNone")}
      </ReviewRow>

      <ReviewRow label={t("cockpitOutletNew.reviewTelegram")}>
        {state.provision_managers_chat
          ? t("cockpitOutletNew.reviewTelegramYes")
          : t("cockpitOutletNew.reviewTelegramNo")}
      </ReviewRow>
    </dl>
  );
}

function ReviewRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground">{children}</dd>
    </div>
  );
}
