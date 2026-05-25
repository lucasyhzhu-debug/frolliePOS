import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Toaster } from "sonner";
import { router } from "@/router";
import "@/index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

if (!convexUrl) {
  // Surfacing this early is friendlier than a runtime "convex client not configured" error mid-render.
  console.warn("[frollie-pos] VITE_CONVEX_URL is not set. Copy .env.example → .env.local and `npx convex dev`.");
}

const convex = new ConvexReactClient(convexUrl ?? "https://placeholder.convex.cloud");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors closeButton />
    </ConvexProvider>
  </React.StrictMode>,
);
