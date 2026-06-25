import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { lazy } from "react";
import { RootLayout } from "@/components/layout/RootLayout";
import { PublicShell } from "@/components/layout/PublicShell";
import { RouteErrorBoundary } from "@/components/layout/RouteErrorBoundary";

/*
 * Route table mirrors README.md's planned structure and the wireframe IA:
 *   /login                       — staff list → PIN (LoginA)
 *   /                            — HomeNav launcher (post-login landing)
 *   /sale                        — cart / new sale (CartA)
 *   /sale/drafts                 — saved drafts
 *   /sale/voucher                — apply voucher
 *   /sale/charge/:txnId          — QR display (ChargeA)
 *   /sale/charge/:txnId/success  — paid screen
 *   /stock                       — stock check (inventory)
 *   /lock                        — end-of-shift lock + handoff
 *   /refund/:txnId               — refund flow (mgr-PIN gated via WA)
 *   /history                     — transaction history (staff sees own + today)
 *   /settlements                 — payout reconciliation (visible to staff + mgr)
 *
 *   /mgr                         — MgrHomeMobile (live tape + approvals)
 *   /mgr/dashboard               — DashA (laptop-first)
 *   /mgr/products                — ProductsManager (taxonomy editor)
 *   /mgr/vouchers                — VoucherManager (v0.6)
 *   /mgr/spoilage                — Spoilage entry (v0.6)
 *   /mgr/receipt                 — ReceiptConfig
 *
 *   /wait/:requestId             — StaffWaitingApproval (the requester's screen)
 *   /approve/:token              — Telegram approve landing (PUBLIC — no auth)
 *                                  Handles staff_pin_reset + manual_payment_override variants
 *
 *   /r/:receiptNumber            — public receipt page (no auth, signed URL)
 *
 * lazy() loads the bundle on first visit — keeps the initial PWA payload small,
 * which matters on mall WiFi.
 */

const Login = lazy(() => import("@/routes/login"));
const Home = lazy(() => import("@/routes/home"));
const Sale = lazy(() => import("@/routes/sale"));
const SaleDrafts = lazy(() => import("@/routes/sale/drafts"));
const SaleVoucher = lazy(() => import("@/routes/sale/voucher"));
const SaleCharge = lazy(() => import("@/routes/sale/charge"));
const SaleChargeSuccess = lazy(() => import("@/routes/sale/charge-success"));
const Stock = lazy(() => import("@/routes/stock"));
const StockRecount = lazy(() => import("@/routes/stock/recount"));
const StockDetail = lazy(() => import("@/routes/stock/$skuId"));
const Lock = lazy(() => import("@/routes/lock"));
const ShiftStart = lazy(() => import("@/routes/shift/start"));
const ShiftEnd = lazy(() => import("@/routes/shift/end"));
const ShiftHandover = lazy(() => import("@/routes/shift/handover"));
const Refund = lazy(() => import("@/routes/refund"));
const RefundDetail = lazy(() => import("@/routes/refund/detail"));
const Account = lazy(() => import("@/routes/account"));
const History = lazy(() => import("@/routes/history"));
const HistoryDetail = lazy(() => import("@/routes/history/$txnId"));
const Settlements = lazy(() => import("@/routes/settlements"));

const MgrHome = lazy(() => import("@/routes/mgr/home"));
const MgrDashboard = lazy(() => import("@/routes/mgr/dashboard"));
const MgrProducts = lazy(() => import("@/routes/mgr/products"));
const MgrReceipt = lazy(() => import("@/routes/mgr/receipt"));
const MgrRefundsPending = lazy(() => import("@/routes/mgr/refunds-pending"));
const MgrTelegramChats = lazy(() => import("@/routes/mgr/telegram-chats"));
const MgrStaff = lazy(() => import("@/routes/mgr/staff"));
const MgrVouchers = lazy(() => import("@/routes/mgr/vouchers"));
const MgrSpoilage = lazy(() => import("@/routes/mgr/spoilage"));
const MgrStock = lazy(() => import("@/routes/mgr/stock"));
const MgrDeviceSetup = lazy(() => import("@/routes/mgr/device-setup"));
const MgrDevice = lazy(() => import("@/routes/mgr/device"));
const MgrAudit = lazy(() => import("@/routes/mgr/audit"));

const CockpitLogin = lazy(() => import("@/routes/cockpit/login"));
const CockpitHome = lazy(() => import("@/routes/cockpit/index"));
const CockpitOutlets = lazy(() => import("@/routes/cockpit/outlets"));
const CockpitOutletNew = lazy(() => import("@/routes/cockpit/outlets/new"));

const Wait = lazy(() => import("@/routes/wait"));
const Approve = lazy(() => import("@/routes/approve"));

const Receipt = lazy(() => import("@/routes/receipt"));
const Activate = lazy(() => import("@/routes/activate"));

const routes: RouteObject[] = [
  // Public siblings: wrapped under PublicShell so they share one errorElement.
  {
    element: <PublicShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: "/activate", element: <Activate /> },
      { path: "/approve/:token", element: <Approve /> },
      { path: "/r/:receiptNumber", element: <Receipt /> },
    ],
  },

  // App shell: RootLayout handles session gate + redirects unauthenticated
  // traffic to /login. errorElement catches chunk-load failures inside the shell.
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: "login", element: <Login /> },
      // Owner cockpit (v2.0 owner-auth, ADR-052). Lives under RootLayout so the
      // session gate runs; RootLayout exempts /cockpit/login from the no-session
      // redirect (mirrors /login), bounces wrong-plane sessions here, and requires
      // an active cockpit session for every other /cockpit/* route. /cockpit is the
      // post-login landing target (its absence would bounce-loop — see index.tsx).
      { path: "cockpit/login", element: <CockpitLogin /> },
      { path: "cockpit", element: <CockpitHome /> },
      { path: "cockpit/outlets", element: <CockpitOutlets /> },
      { path: "cockpit/outlets/new", element: <CockpitOutletNew /> },
      { index: true, element: <Home /> },
      { path: "sale", element: <Sale /> },
      { path: "sale/drafts", element: <SaleDrafts /> },
      { path: "sale/voucher", element: <SaleVoucher /> },
      { path: "sale/charge/:txnId", element: <SaleCharge /> },
      { path: "sale/charge/:txnId/success", element: <SaleChargeSuccess /> },
      { path: "stock", element: <Stock /> },
      { path: "stock/recount", element: <StockRecount /> },
      { path: "stock/:skuId", element: <StockDetail /> },
      { path: "lock", element: <Lock /> },
      { path: "shift/start", element: <ShiftStart /> },
      { path: "shift/end", element: <ShiftEnd /> },
      { path: "shift/handover", element: <ShiftHandover /> },
      { path: "account", element: <Account /> },
      { path: "refund", element: <Refund /> },
      { path: "refund/:txnId", element: <RefundDetail /> },
      { path: "history", element: <History /> },
      { path: "history/:txnId", element: <HistoryDetail /> },
      { path: "settlements", element: <Settlements /> },
      { path: "wait/:requestId", element: <Wait /> },
      { path: "mgr", element: <MgrHome /> },
      { path: "mgr/dashboard", element: <MgrDashboard /> },
      { path: "mgr/products", element: <MgrProducts /> },
      { path: "mgr/receipt", element: <MgrReceipt /> },
      { path: "mgr/refunds-pending", element: <MgrRefundsPending /> },
      { path: "mgr/telegram-chats", element: <MgrTelegramChats /> },
      { path: "mgr/staff", element: <MgrStaff /> },
      { path: "mgr/device-setup", element: <MgrDeviceSetup /> },
      { path: "mgr/device", element: <MgrDevice /> },
      { path: "mgr/vouchers", element: <MgrVouchers /> },
      { path: "mgr/spoilage", element: <MgrSpoilage /> },
      { path: "mgr/stock", element: <MgrStock /> },
      { path: "mgr/audit", element: <MgrAudit /> },
    ],
  },

  { path: "*", element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
