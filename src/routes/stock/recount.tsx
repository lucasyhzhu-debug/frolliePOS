import { useNavigate } from "react-router";
import { SpokeLayout } from "@/components/layout/SpokeLayout";
import CountStep from "@/components/pos/CountStep";

export default function RecountScreen() {
  const navigate = useNavigate();
  return (
    <SpokeLayout title="Hitung ulang stok" backTo="/stock">
      <CountStep
        onSubmitted={() => navigate("/stock")}
        submitLabel="Simpan hitungan"
      />
    </SpokeLayout>
  );
}
