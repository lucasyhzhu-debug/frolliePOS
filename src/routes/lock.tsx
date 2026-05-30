import { SpokeLayout } from "@/components/layout/SpokeLayout";
import Stub from "@/components/layout/Stub";

/**
 * Lock / handoff screen — skeleton wrap. Full implementation ships in Task 23.
 * SpokeLayout applied here so the sticky header chrome is consistent even while
 * the stub placeholder is in place.
 */
export default function Lock() {
  return (
    <SpokeLayout title="Lock / handoff">
      <Stub name="Lock + handoff" />
    </SpokeLayout>
  );
}
