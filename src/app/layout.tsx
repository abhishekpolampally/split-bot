import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import { ServiceWorker } from "@/components/ServiceWorker";
import "./globals.css";

const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SplitBot",
  description: "Split bills by chatting. Tag @splitbot and confirm in one tap.",
  applicationName: "SplitBot",
  appleWebApp: { capable: true, title: "SplitBot", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#10302A",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${manrope.variable} h-full antialiased`}>
      <body className="h-full font-sans">
        <div className="mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden bg-white sm:my-0 sm:shadow-xl">
          {children}
        </div>
        <ServiceWorker />
      </body>
    </html>
  );
}
