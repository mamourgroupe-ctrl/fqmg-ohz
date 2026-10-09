import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "FQMG-OHZ NEXT — استوديو الفيديو الذكي",
  description: "Phase 2: مخطط فيديو مستقل ومحرك صوت خلف واجهة موحّدة لـ FQMG-OHZ NEXT.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
