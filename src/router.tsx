import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { lazy } from "react";
import { RootLayout } from "@/components/layout/RootLayout";

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
 *   /stock/in                    — stock-in
 *   /lock                        — end-of-shift lock + handoff
 *   /refund/:txnId               — refund flow (mgr-PIN gated via WA)
 *   /history                     — transaction history (staff sees own + today)
 *   /settlements                 — payout reconciliation (visible to staff + mgr)
 *
 *   /mgr                         — MgrHomeMobile (live tape + approvals)
 *   /mgr/dashboard               — DashA (laptop-first)
 *   /mgr/products                — ProductsManager (taxonomy editor)
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
const StockIn = lazy(() => import("@/routes/stock/in"));
const Lock = lazy(() => import("@/routes/lock"));
const Refund = lazy(() => import("@/routes/refund"));
const History = lazy(() => import("@/routes/history"));
const Settlements = lazy(() => import("@/routes/settlements"));

const MgrHome = lazy(() => import("@/routes/mgr/home"));
const MgrDashboard = lazy(() => import("@/routes/mgr/dashboard"));
const MgrProducts = lazy(() => import("@/routes/mgr/products"));
const MgrReceipt = lazy(() => import("@/routes/mgr/receipt"));
const MgrTelegramChats = lazy(() => import("@/routes/mgr/telegram-chats"));

const Wait = lazy(() => import("@/routes/wait"));
const Approve = lazy(() => import("@/routes/approve"));

const Receipt = lazy(() => import("@/routes/receipt"));
const Activate = lazy(() => import("@/routes/activate"));

const routes: RouteObject[] = [
  // Public routes — no auth, no app shell
  { path: "/activate", element: <Activate /> },
  { path: "/approve/:token", element: <Approve /> },
  { path: "/r/:receiptNumber", element: <Receipt /> },

  // App shell — RootLayout handles session gate + redirects unauthenticated traffic to /login
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { path: "login", element: <Login /> },
      { index: true, element: <Home /> },
      { path: "sale", element: <Sale /> },
      { path: "sale/drafts", element: <SaleDrafts /> },
      { path: "sale/voucher", element: <SaleVoucher /> },
      { path: "sale/charge/:txnId", element: <SaleCharge /> },
      { path: "sale/charge/:txnId/success", element: <SaleChargeSuccess /> },
      { path: "stock", element: <Stock /> },
      { path: "stock/in", element: <StockIn /> },
      { path: "lock", element: <Lock /> },
      { path: "refund/:txnId", element: <Refund /> },
      { path: "history", element: <History /> },
      { path: "settlements", element: <Settlements /> },
      { path: "wait/:requestId", element: <Wait /> },
      { path: "mgr", element: <MgrHome /> },
      { path: "mgr/dashboard", element: <MgrDashboard /> },
      { path: "mgr/products", element: <MgrProducts /> },
      { path: "mgr/receipt", element: <MgrReceipt /> },
      { path: "mgr/telegram-chats", element: <MgrTelegramChats /> },
    ],
  },

  { path: "*", element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter(routes);
