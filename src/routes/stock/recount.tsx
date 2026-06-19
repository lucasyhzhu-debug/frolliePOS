import { useNavigate } from "react-router";
import { toast } from "sonner";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import CountStep from "@/components/pos/CountStep";

export default function RecountScreen() {
  const navigate = useNavigate();
  return (
    <SpokeLayout title="Hitung ulang stok" backTo="/stock">
      <CountStep
        onSubmitted={(changed) => {
          toast.success(`${changed} SKU diperbarui`);
          navigate("/stock");
        }}
        submitLabel="Simpan hitungan"
      />
    </SpokeLayout>
  );
}
