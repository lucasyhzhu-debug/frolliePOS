import { useState } from "react";
import { Navigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useSession } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import { fmtDate, fmtTime } from "@/lib/format";

/**
 * /mgr/audit — manager-only append-only activity trail (ADR-007: read-only,
 * no row actions). Wires the long-orphaned audit.public.list query. Actor
 * names are server-derived (Part A backend).
 */
type AuditRow = FunctionReturnType<typeof api.audit.public.list>[number];

const PAGE = 100;
const MAX = 500; // server clamps limit to 500 (auditListHandler).

export default function MgrAudit() {
  const session = useSession();

  if (session.status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }
  if (session.status !== "active" || session.staff.role !== "manager") {
    return <Navigate to="/" replace />;
  }
  return <MgrAuditInner sessionId={session.sessionId} />;
}

function MgrAuditInner({ sessionId }: { sessionId: Id<"staff_sessions"> }) {
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState("");
  const action = filter.trim() || undefined;
  const rows = useQuery(api.audit.public.list, { sessionId, limit, action });

  return (
    <SpokeLayout title="Audit log" backTo="/mgr">
      <div className="flex flex-1 flex-col gap-3 p-4">
        <Input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setLimit(PAGE);
          }}
          placeholder="Filter by action (e.g. refund.committed)"
          data-testid="audit-filter"
        />
        {rows === undefined ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">No audit entries.</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {rows.map((r) => (
                <AuditCard key={r._id} row={r} />
              ))}
            </div>
            {rows.length >= limit && limit < MAX && (
              <Button
                variant="outline"
                onClick={() => setLimit((n) => Math.min(n + PAGE, MAX))}
                data-testid="audit-load-more"
              >
                Load more
              </Button>
            )}
          </>
        )}
      </div>
    </SpokeLayout>
  );
}

function AuditCard({ row }: { row: AuditRow }) {
  return (
    <Card className="flex flex-col gap-1 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm">{row.action}</span>
        <span className="text-xs text-muted-foreground">
          {fmtDate(row.created_at)} · {fmtTime(row.created_at)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{row.actor_name}</span>
        <span>·</span>
        <span>
          {row.entity_type}
          {row.entity_id ? ` ${row.entity_id}` : ""}
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {row.source}
        </Badge>
      </div>
      {row.reason && (
        <p className="text-xs text-muted-foreground line-clamp-2">{row.reason}</p>
      )}
    </Card>
  );
}
