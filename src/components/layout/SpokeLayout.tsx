import { ReactNode } from "react";
import { AppHeader, AppHeaderProps } from "./AppHeader";

interface SpokeLayoutProps extends AppHeaderProps {
  children: ReactNode;
}

export function SpokeLayout({ children, ...header }: SpokeLayoutProps) {
  return (
    <>
      <AppHeader {...header} />
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
