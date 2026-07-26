import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Environmental Logger",
  description: "Readings from the ESP32 environmental logger",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
