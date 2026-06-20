import { useNavigate } from "react-router";
import { toast } from "sonner";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import CountStep from "@/components/pos/CountStep";
import { useT } from "@/lib/i18n";

export default function RecountScreen() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <SpokeLayout title={t("recount.title")} backTo="/stock">
      <CountStep
        onSubmitted={(changed) => {
          toast.success(t("recount.savedToast", { count: String(changed) }));
          navigate("/stock");
        }}
        submitLabel={t("recount.submitLabel")}
      />
    </SpokeLayout>
  );
}
