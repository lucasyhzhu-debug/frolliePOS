// src/components/pos/flags/FlagID.tsx — Indonesia: red over white
// National flag colors are the SANCTIONED exception to semantic-token rule (ADR-047).
export function FlagID({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 3 2" className={className} aria-hidden preserveAspectRatio="xMidYMid slice">
      <rect width="3" height="1" y="0" fill="#CE1126" />
      <rect width="3" height="1" y="1" fill="#FFFFFF" />
    </svg>
  );
}
