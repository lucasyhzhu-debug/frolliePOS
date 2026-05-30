import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
  if (props.variant === "cart") {
    return (
      <Dialog open={props.open} onOpenChange={(o) => !o && props.onCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave this sale?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Your cart has items.</p>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="default"
              onClick={async () => {
                await props.onSaveDraft();
                props.onProceed();
              }}
            >
              Save as draft
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                props.onDiscard();
                props.onProceed();
              }}
            >
              Discard
            </Button>
            <Button variant="outline" onClick={props.onCancel}>
              Cancel
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
          <DialogTitle>Cancel this payment?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The active QR / VA will be invalidated.
        </p>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="destructive"
            onClick={async () => {
              await props.onCancelPayment();
              props.onProceed();
            }}
          >
            Cancel payment
          </Button>
          <Button variant="outline" onClick={props.onCancel}>
            Keep waiting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
