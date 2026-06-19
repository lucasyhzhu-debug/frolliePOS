import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

interface CartProps {
  variant: "cart";
  open: boolean;
  onCancel: () => void;
  onProceed: () => void;
  onSaveDraft: () => Promise<void>;
  onDiscard: () => void;
}

interface PaymentProps {
  variant: "payment";
  open: boolean;
  onCancel: () => void;
  onProceed: () => void;
  onCancelPayment: () => Promise<void>;
}

type Props = CartProps | PaymentProps;

export function AbandonCartDialog(props: Props) {
  const t = useT();

  if (props.variant === "cart") {
    return (
      <Dialog open={props.open} onOpenChange={(o) => !o && props.onCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("abandonCart.leaveTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("abandonCart.cartBody")}</p>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="default"
              onClick={async () => {
                await props.onSaveDraft();
                props.onProceed();
              }}
            >
              {t("abandonCart.saveDraft")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                props.onDiscard();
                props.onProceed();
              }}
            >
              {t("abandonCart.discard")}
            </Button>
            <Button variant="outline" onClick={props.onCancel}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("abandonCart.cancelPaymentTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("abandonCart.cancelPaymentBody")}
        </p>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="destructive"
            onClick={async () => {
              await props.onCancelPayment();
              props.onProceed();
            }}
          >
            {t("abandonCart.cancelPaymentAction")}
          </Button>
          <Button variant="outline" onClick={props.onCancel}>
            {t("abandonCart.keepWaiting")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
