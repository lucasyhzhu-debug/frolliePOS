import { useState } from "react";
import { cn } from "@/lib/utils";
import { deriveInitials, resolveHue, chipColors } from "@/lib/productThumb";

/** Square product thumbnail (v1.2 #3): photo when present, else a deterministic
 *  colored initials chip. Decorative — the surrounding control carries the
 *  product name (sale Card aria-label; mgr row adjacent text), so alt="". */
export function ProductThumb({
  photoUrl,
  initials,
  hue,
  name,
  code,
  className,
}: {
  photoUrl?: string | null;
  initials?: string;
  hue?: number;
  name: string;
  code: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (photoUrl && !broken) {
    return (
      <img
        src={photoUrl}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn("aspect-square w-full rounded-md object-cover", className)}
      />
    );
  }
  const text = deriveInitials(name, initials);
  const { bg, fg, border } = chipColors(resolveHue(code, hue));
  return (
    <div
      aria-hidden
      className={cn(
        "flex aspect-square w-full items-center justify-center rounded-md text-lg font-bold tracking-wide",
        className,
      )}
      style={{ background: bg, color: fg, border: `1px solid ${border}` }}
    >
      {text}
    </div>
  );
}
